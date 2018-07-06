const h = require('virtual-dom/h')
const setupDom = require('./engine')
const renderGraph = require('./graph')
const { setupSimulation, setupSimulationForces } = require('./simulation')

const graphWidth = 960
const graphHeight = 600

module.exports = startApp

function startApp(opts = {}) {
  const { store } = opts

  // view state
  let selectedNode = undefined
  let currentGraph = {
    nodes: [],
    links: [],
  }

  // view actions
  const actions = {
    // ui state
    selectNode: (nodeId) => {
      selectedNode = nodeId
      rerender()
    },
    // network state
    // single node
    restartNode: async (nodeId) => {
      await sendToClient(nodeId, 'refresh', [])
    },
    pingNode: async (nodeId) => {
      await sendToClient(nodeId, 'ping', [])
    },
    // broadcast
    restartAllShortDelay: () => {
      global.serverAsync.refreshShortDelay()
    },
    restartAllLongDelay: () => {
      global.serverAsync.refreshLongDelay()
    },
  }

  // setup dom + render
  const updateDom = setupDom({ container: document.body })
  rerender()

  // setup force simulation
  const simulation = setupSimulation(currentGraph)

  // setup rerender hooks
  simulation.on('tick', rerender)
  store.subscribe(rerender)
  store.subscribe((state) => {
    // merge state
    const clientData = state.clients
    const newGraph = buildGraph(clientData)
    currentGraph = mergeGraph(currentGraph, newGraph)
    // reset simulation
    setupSimulationForces(simulation, currentGraph)
    // trigger redraw
    rerender()
  })

  async function sendToClient (nodeId, method, args) {
    console.log(`START sending to "${nodeId}" "${method}" ${args}`)
    const start = Date.now()
    const result = await global.serverAsync.sendToClient(nodeId, method, args)
    const end = Date.now()
    const duration = end - start
    console.log(`END sending to "${nodeId}" "${method}" ${args} - ${result} ${duration}ms`)
  }

  function rerender() {
    const state = getState()
    updateDom(render(state, actions))
  }

  // mix in local graph over store state
  function getState() {
    return Object.assign({},
      store.getState(),
      {
        selectedNode,
        graph: currentGraph,
      },
    )
  }
}

function render(state, actions) {
  const { graph, selectedNode } = state
  return (

    h('.app-container', [

      appStyle(),

      h('section.flexbox-container', {
        // style: {
        //   display: 'flex',
        //   alignItems: 'center',
        // }
      }, [
        h('div.main', {
          // style: {
          //   flex: 1,
          // }
        }, [
          h('div', [
            h('.app-info-count', `nodes: ${graph.nodes.length}`),
            h('.app-info-count', `links: ${graph.links.length}`),
          ]),
          renderGraph(state, actions),
        ]),

        h('div.sidebar', {
          // style: {
          //   flex: 1,
          // }
        }, [
          h('h2', 'node controls'),
          h('.app-selected-node', [
            `selected: ${selectedNode || 'none'}`,
          ]),
          h('button', {
            disabled: !selectedNode,
            onclick: () => actions.restartNode(selectedNode),
          }, 'restart'),
          h('button', {
            disabled: !selectedNode,
            onclick: () => actions.pingNode(selectedNode),
          }, 'ping'),

          h('h2', 'global controls'),
          h('button', {
            onclick: () => actions.restartAllShortDelay()
          }, 'restart all (5-10s delay)'),
          h('button', {
            onclick: () => actions.restartAllLongDelay()
          }, 'restart all (2-10m delay)'),
        ]),
      ])

    ])

  )
}

function mergeGraph(oldGraph, newGraph) {
  const graph = {}
  // create index for faster lookups during merge
  const graphIndex = createGraphIndex(oldGraph)
  // merge old graph for existing nodes + links
  graph.nodes = newGraph.nodes.map((node) => {
    return Object.assign({
      // creating all nodes at the same spot creates a big bang
      // that accidently sorts the structures out nicely
      x: graphWidth / 2,
      y: graphHeight / 2,
    }, graphIndex.nodes[node.id], node)
  })
  graph.links = newGraph.links.map((link) => {
    return Object.assign({}, graphIndex.links[link.id], link)
  })
  return graph
}

function createGraphIndex(graph) {
  const graphIndex = { nodes: {}, links: {} }
  graph.nodes.forEach(node => {
    graphIndex.nodes[node.id] = node
  })
  graph.links.forEach(link => {
    graphIndex.links[link.id] = link
  })
  return graphIndex
}

function appStyle() {
  return h('style', [
    `
    body, html {
      margin: 0;
      padding: 0;
      height: 100%;
    }

    .app-container {
      height: 100%;
    }

    .flexbox-container {
    	display: flex;
    	width: 100%;
      height: 100%;
    }

    .sidebar {
    	order: 1;
    	flex: 1;
    	background-color: #dedede;
      flex-basis: auto;
      padding: 0 12px;
      min-height: 666px;
    }

    .main {
    	order: 1;
    	flex: 5;
      padding: .5rem;
    }

    .links line {
      stroke: #999;
      stroke-opacity: 0.6;
    }

    .nodes circle {
      stroke: #fff;
      stroke-width: 1.5px;
    }

    .legend {
      font-family: "Arial", sans-serif;
      font-size: 11px;
    }
    `
  ])
}

function buildGraph(data) {
  const GOOD = '#1f77b4'
  const BAD = '#aec7e8'
  const MISSING = '#ff7f0e'

  const graph = { nodes: [], links: [] }

  // first add kitsunet nodes
  Object.keys(data).forEach((clientId) => {
    const peerData = data[clientId].peers
    const badResponse = (typeof peerData !== 'object')
    const newNode = { id: clientId, color: badResponse ? BAD : GOOD }
    graph.nodes.push(newNode)
  })

  // then links
  Object.keys(data).forEach((clientId) => {
    const peerData = data[clientId].peers
    if (typeof peerData !== 'object') return
    Object.keys(peerData).forEach((peerId) => {
      // if connected to a missing node, create missing node
      const alreadyExists = !!graph.nodes.find(item => item.id === peerId)
      if (!alreadyExists) {
        const newNode = { id: peerId, color: MISSING }
        graph.nodes.push(newNode)
      }
      const rtt = peerData[peerId]
      const didTimeout = rtt === 'timeout'
      // const linkValue = Math.pow((10 - Math.log(rtt)), 2)
      const linkValue = didTimeout ? 0.1 : 2
      const linkId = `${clientId}-${peerId}`
      const newLink = { id: linkId, source: clientId, target: peerId, value: linkValue }
      graph.links.push(newLink)
    })
  })

  return graph
}
//
// function mapObject(obj, fn) {
//   const newObj = {}
//   Object.entries(obj).forEach(([key, value], index) => {
//     newObj[key] = fn(key, value, index)
//   })
//   return newObj
// }
