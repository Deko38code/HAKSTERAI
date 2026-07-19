import React from 'react';
import { render } from 'ink';
import App from './App.jsx';

let rendered = false;

export function start() {
  if (rendered) return; // prevent double render
  rendered = true;
  render(<App />);
}