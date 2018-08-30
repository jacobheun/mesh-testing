const pingWithTimeout = require('./pingWithTimeout')
const timeout = require('../util/timeout')

module.exports = { pingAllClientsOnInterval }

async function pingAllClientsOnInterval ({
  clients,
  disconnectClient,
  heartBeatInterval,
  pingTimeout
}) {
  while (true) {
    try {
      await pingClientsWithTimeout()
    } catch (err) {
      console.error(err)
    }
    await timeout(heartBeatInterval)
  }

  // poll for connection status
  async function pingClientsWithTimeout () {
    // try all clients in sync
    await Promise.all(clients.map(async (client) => {
      try {
        return await pingWithTimeout(client.rpcAsync, pingTimeout)
      } catch (err) {
        await disconnectClient(client)
      }
    }))
  }
}
