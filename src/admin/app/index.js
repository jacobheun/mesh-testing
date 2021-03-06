import React from 'react';
import ReactDOM from 'react-dom';
import './index.css';
import App from './App';

module.exports = ({ store, serverAsync }) => {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  ReactDOM.render(<App store={store} server={serverAsync}/>, root);
}