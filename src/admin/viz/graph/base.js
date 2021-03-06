'use strict'

const h = require('virtual-dom/h')
const s = require('virtual-dom/virtual-hyperscript/svg')

module.exports = renderGraph

function renderGraph (state, actions, { renderNode, renderLink }) {
  const { graph } = state
  const { nodes, links } = graph

  return (

    s('svg', {
      width: 960,
      height: 600
    }, [
      s('g', { class: 'links' }, links.map((link) => renderLink(link, state, actions))),
      s('g', { class: 'nodes' }, nodes.map((node) => renderNode(node, state, actions)))
    ])

  )
}
