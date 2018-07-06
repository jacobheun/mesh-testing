const express = require('express')
const cors = require('cors')
const expressWebSocket = require('express-ws')
const websocketStream = require('websocket-stream/stream')
const endOfStream = require('end-of-stream')
const hat = require('hat')
const ObservableStore = require('obs-store')
const pump = require('pump')
const pify = require('pify')
const timeout = require('../util/timeout')
const createHttpClientHandler = require('./http-poll-stream')
const handleClientTimeouts = require('./clientTimeout')
// const multiplexRpc = require('multiplex-rpc')
const multiplexRpc = require('../util/multiplexRpc')
const { cbifyObj } = require('../util/cbify')

const app = express()
// enable CORS responses
app.use(cors())
// enable websocket support
expressWebSocket(app, null, {
  perMessageDeflate: false,
})

const sec = 1000
const min = 60 * sec

const heartBeatInterval = 1 * min
const remoteCallTimeout = 45 * sec

// network state
const networkStore = new ObservableStore({ clients: {} })
const clients = []

// report stack for unhandled promise rejections
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection:', reason);
  console.error(reason)
});

//
// setup server routes
//

// setup client

app.post('/stream/:connectionId', createHttpClientHandler({
  onNewConnection: ({ connectionStream, req }) => {
    handleClient(connectionStream, req)
  }
}))

app.ws('/', function(ws, req) {
  const stream = websocketStream(ws, {
    binary: true,
  })
  handleClient(stream, req)
})

// setup admin

const secret = hat(256)
console.log('secret:', secret)

app.post(`/${secret}/stream/:connectionId`, createHttpClientHandler({
  onNewConnection: ({ connectionStream, req }) => {
    handleAdmin(connectionStream, req)
  }
}))

app.ws(`/${secret}`, function(ws, req) {
  const stream = websocketStream(ws, {
    binary: true,
  })

  handleAdmin(stream, req)
})

app.listen(9000, () => {
  console.log('ws listening on 9000')
})

//
// handle client life cycle
//

handleClientTimeouts({
  clients,
  disconnectClient,
  heartBeatInterval,
  remoteCallTimeout,
})

// clear disconnect nodes from network state
// this should happen automatically as part of the disconnect process
// but i can see that it somehow is not
setInterval(() => {
  const networkState = networkStore.getState()
  Object.keys(networkState.clients).forEach((clientId) => {
    const client = clients.find(c => c.peerId === clientId)
    if (!client) {
      console.log(`orphaned client found, cleaning up: ${clientId}`)
      delete networkState.clients[clientId]
    }
  })
  networkStore.putState(networkState)
}, 10 * sec)

function disconnectClient(clientId) {
  const index = clients.findIndex(client => client.peerId === clientId)
  console.log(`disconnecting client "${clientId}"`)
  if (index === -1) return console.log(`unable to find client "${clientId}"`)
  const client = clients[index]
  // remove peer
  clients.splice(index, 1)
  // destroy stream
  client.stream.destroy()
  // update network state
  const networkState = networkStore.getState()
  delete networkState.clients[clientId]
  networkStore.putState(networkState)
  // report current connected count
  console.log(`${clients.length} peers connected`)
}

async function handleClient(stream, req) {
  // handle disconnect
  // stream.on('error', (error) => {
  //   console.log('client disconnected - stream end')
  //   // Ignore network errors like `ECONNRESET`, `EPIPE`, etc.
  //   if (error.errno) return
  //   throw error
  // })

  // attempt connect
  const client = {
    isAlive: true,
    ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
    stream,
  }

  const serverRpcImplementationForClient = cbifyObj({
    ping: async () => 'pong',
    setPeerId: async (peerId) => {
      client.peerId = peerId
      // update network state
      const networkState = networkStore.getState()
      networkState.clients[peerId] = { peers: [] }
      networkStore.putState(networkState)
      return 'yuss'
    },
    submitNetworkState: async (clientState) => {
      const peerId = client.peerId
      if (!peerId) return
      if (!clients.includes(client)) return
      // update network state
      const networkState = networkStore.getState()
      networkState.clients[peerId] = clientState
      networkStore.putState(networkState)
    },
    disconnect: async () => {
      console.log(`client "${client.peerId}" sent disconnect request`)
      disconnectClient(client.peerId)
    },
  })
  const clientRpcInterfaceForServer = [
    'ping',
    'refresh',
    'refreshShortDelay',
    'refreshLongDelay',
    'eval',
    'pingAll',
  ]

  const rpcConnection = multiplexRpc(serverRpcImplementationForClient)
  pump(
    stream,
    rpcConnection,
    stream,
    (err) => {
      console.log('client rpcConnection disconnect', err.message)
    }
  )

  client.rpc = rpcConnection.wrap(clientRpcInterfaceForServer)
  client.rpcAsync = pify(client.rpc)

  clients.push(client)
  console.log('peer connected')
  console.log(`${clients.length} peers connected`)
}

async function handleAdmin(stream, request) {

  // // handle disconnect
  // stream.on('error', (error) => {
  //   console.log('admin disconnected - stream end')
  //   // Ignore network errors like `ECONNRESET`, `EPIPE`, etc.
  //   if (error.errno) return
  //   throw error
  // })

  // attempt connect
  const serverRpcImplementationForAdmin = cbifyObj({
    ping: async () => 'pong',
    // server data
    getPeerCount: async () => clients.length,
    getNetworkState: async () => networkStore.getState(),
    // send to client
    sendToClient: async (clientId, method, args) => {
      console.log(`forwarding "${method}" with (${args}) to client ${clientId}`)
      const client = clients.find(c => c.peerId === clientId)
      if (!client) {
        console.log(`no client found ${clientId}`)
        // znode doesnt like undefined responses
        return 'error: missing client'
      }
      return await sendCallWithTimeout(client.rpcAsync, method, args, remoteCallTimeout)
    },
    // broadcast
    send: async (method, args) => {
      console.log(`broadcasting "${method}" with (${args}) to ${clients.length} client(s)`)
      return await broadcastCall(method, args, remoteCallTimeout)
    },
    refresh: async () => await broadcastCall('refresh', [], remoteCallTimeout),
    refreshShortDelay: async () => await broadcastCall('refreshShortDelay', [], remoteCallTimeout),
    refreshLongDelay: async () => await broadcastCall('refreshLongDelay', [], remoteCallTimeout),
  })
  const adminRpcInterfaceForServer = [
    'ping',
    'sendNetworkState',
  ]

  const rpcConnection = multiplexRpc(serverRpcImplementationForAdmin)
  pump(
    stream,
    rpcConnection,
    stream,
    (err) => {
      console.log('admin rpcConnection disconnect', err.message)
    }
  )

  const adminRpc = rpcConnection.wrap(adminRpcInterfaceForServer)
  const adminRpcAsync = pify(adminRpc)
  console.log('admin connected')

  // send network state on updates
  networkStore.subscribe(networkState => {
    adminRpcAsync.sendNetworkState(networkState)
  })

}

//
// client communication
//

function broadcastCall(method, args, timeoutDuration) {
  console.log(`broadcasting to ${clients.length} clients:`, method, args)
  return Promise.all(clients.map((client) => sendCallWithTimeout(client.rpcAsync, method, args, timeoutDuration)))
}

function sendCallWithTimeout(rpc, method, args, timeoutDuration) {
  return Promise.race([
    timeout(timeoutDuration, 'timeout'),
    sendCall(rpc, method, args),
  ])
}

async function sendCall(rpc, method, args) {
  let result
  try {
    result = await rpc[method].apply(rpc, args)
  } catch (err) {
    return err.message
  }
  console.log(`got result: ${result}`)
  return result
}