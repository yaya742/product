import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/noto-sans-sc';
import './style.css';
import './refinements.css';
import './harness.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
