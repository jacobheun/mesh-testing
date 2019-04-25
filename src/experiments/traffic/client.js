'use strict'

const Stat = require('libp2p-switch/src/stats/stat')

// custom libp2p stats
const statDirectionToEvent = {
  in: 'dataReceived',
  out: 'dataSent'
}

class TrafficExperiment {
  constructor ({ node }) {
    this.libp2pPeersStats = {}

    // track stats for each peer connected
    node.on('peer:connect', (peerInfo) => {
      const peerId = peerInfo.id.toB58String()
      this.libp2pPeersStats[peerId] = { transports: {}, protocols: {}, mystery: createStat() }
    })
    // remove stats for each peer disconnected
    node.on('peer:disconnect', (peerInfo) => {
      const peerId = peerInfo.id.toB58String()
      delete this.libp2pPeersStats[peerId]
    })
    // record stats for each message
    node._switch.observer.on('message', (...args) => this.recordStats(...args))
    
    // grab a timeline of traffic usage
    this.timeSeries = { global: { protocols: {} } }
    const timeSeriesMaxSize = 10
    setInterval(() => {
      const state = libp2pStatsToJson(this.libp2pPeersStats)
      const timeSeriesProtocols = this.timeSeries.global.protocols
      Object.entries(state.global.protocols).forEach(([protocolName, protocolStats]) => {
        const protocolTimeSeries = timeSeriesProtocols[protocolName] || (timeSeriesProtocols[protocolName] = {})
        for (let direction of ['dataSent', 'dataReceived']) {
          const newValue = protocolStats.movingAverages[direction]['60000']
          const timeSeries = protocolTimeSeries[direction] || []
          timeSeries.push(newValue)
          protocolTimeSeries[direction] = timeSeries.slice(-timeSeriesMaxSize)
        }
      })
    }, 10 * 1000)
  }

  getState () {
    const baseState = libp2pStatsToJson(this.libp2pPeersStats)
    baseState.timeSeries = this.timeSeries
    return baseState
  }

  recordStats (peerId, transport, protocol, direction, bufferLength) {
    // sanity check
    if (!peerId) return console.log('switch message without peerId', peerId, transport, protocol, direction, bufferLength)
    // setup peer stats
    let peerStats = this.libp2pPeersStats[peerId]
    if (!peerStats) return
    // update timestamp
    peerStats.timestamp = Date.now()
    // record transport + protocol data (they come in seperately)
    if (transport) {
      const transportStats = peerStats.transports[transport] || (peerStats.transports[transport] = createStat())
      transportStats.push(statDirectionToEvent[direction], bufferLength)
    }
    if (protocol) {
      const protocolStats = peerStats.protocols[protocol] || (peerStats.protocols[protocol] = createStat())
      protocolStats.push(statDirectionToEvent[direction], bufferLength)
    }
    // record mysterious messages that dont have a transport or protocol
    if (!protocol && !transport) {
      peerStats.mystery.push(statDirectionToEvent[direction], bufferLength)
    }
  }

}

module.exports = TrafficExperiment


function libp2pStatsToJson (peerStats) {
  const allStats = { global: { transports: {}, protocols: {}, mystery: null }, peers: {} }
  // each peer
  Object.entries(peerStats).forEach(([peerId, peerStatsContainer]) => {
    const peerStats = allStats.peers[peerId] = { transports: {}, protocols: {}, mystery: null }
    // mystery
    const mysteryStats = statObjToJson(peerStatsContainer.mystery)
    addStatsToGlobal(allStats.global, 'mystery', mysteryStats)
    peerStats.mystery = mysteryStats
    // each transport
    Object.keys(peerStatsContainer.transports).forEach((transportName) => {
      const transportStats = statObjToJson(peerStatsContainer.transports[transportName])
      addStatsToGlobal(allStats.global.transports, transportName, transportStats)
      peerStats.transports[transportName] = transportStats
    })
    // each protocol
    Object.keys(peerStatsContainer.protocols).forEach((protocolName) => {
      const protocolStats = statObjToJson(peerStatsContainer.protocols[protocolName])
      addStatsToGlobal(allStats.global.protocols, protocolName, protocolStats)
      peerStats.protocols[protocolName] = protocolStats
    })
  })
  return allStats

  function addStatsToGlobal (accumulator, name, newStats) {
    const container = accumulator[name] = accumulator[name] || createEmptyStatsJson()
    container.snapshot.dataReceived += newStats.snapshot.dataReceived
    container.snapshot.dataSent += newStats.snapshot.dataSent
    container.movingAverages.dataReceived['60000'] += newStats.movingAverages.dataReceived['60000']
    container.movingAverages.dataReceived['300000'] += newStats.movingAverages.dataReceived['300000']
    container.movingAverages.dataReceived['900000'] += newStats.movingAverages.dataReceived['900000']
    container.movingAverages.dataSent['60000'] += newStats.movingAverages.dataSent['60000']
    container.movingAverages.dataSent['300000'] += newStats.movingAverages.dataSent['300000']
    container.movingAverages.dataSent['900000'] += newStats.movingAverages.dataSent['900000']
  }
}

function createEmptyStatsJson () {
  return {
    snapshot: {
      dataReceived: 0,
      dataSent: 0
    },
    movingAverages: {
      dataReceived: {
        '60000': 0,
        '300000': 0,
        '900000': 0
      },
      dataSent: {
        '60000': 0,
        '300000': 0,
        '900000': 0
      }
    }
  }
}

function statObjToJson (statsObj) {
  return {
    snapshot: {
      dataReceived: Number.parseInt(statsObj.snapshot.dataReceived.toString()),
      dataSent: Number.parseInt(statsObj.snapshot.dataSent.toString())
    },
    movingAverages: {
      dataReceived: {
        '60000': statsObj.movingAverages.dataReceived['60000'].movingAverage(),
        '300000': statsObj.movingAverages.dataReceived['300000'].movingAverage(),
        '900000': statsObj.movingAverages.dataReceived['900000'].movingAverage()
      },
      dataSent: {
        '60000': statsObj.movingAverages.dataSent['60000'].movingAverage(),
        '300000': statsObj.movingAverages.dataSent['300000'].movingAverage(),
        '900000': statsObj.movingAverages.dataSent['900000'].movingAverage()
      }
    }
  }
}

function createStat () {
  const stat = new Stat(['dataReceived', 'dataSent'], {
    computeThrottleMaxQueueSize: 1000,
    computeThrottleTimeout: 2000,
    movingAverageIntervals: [
      60 * 1000, // 1 minute
      5 * 60 * 1000, // 5 minutes
      15 * 60 * 1000 // 15 minutes
    ]
  })
  stat.start()
  return stat
}
