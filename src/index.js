// index.js
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';

// Check XenForo's light/dark setting (XF 2.3 uses data-color-scheme on <html>)
const xenforoColorScheme = document.documentElement.getAttribute('data-color-scheme');
// If XenForo's attribute is not present, fall back to system preference.
const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const mode = xenforoColorScheme ? xenforoColorScheme : systemPrefersDark ? 'dark' : 'light';

const theme = createTheme({
  palette: {
    mode: mode,
  },
});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>
);

reportWebVitals();
