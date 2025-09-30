import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { ErrorBoundary } from './components/ErrorBoundary';

// Check XenForo's light/dark setting (XF 2.3 uses data-color-scheme on <html>)
const xenforoColorScheme = document.documentElement.getAttribute('data-color-scheme');
// If XenForo's attribute is not present, fall back to system preference.
const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const mode: 'light' | 'dark' = xenforoColorScheme === 'dark' ? 'dark' : xenforoColorScheme === 'light' ? 'light' : systemPrefersDark ? 'dark' : 'light';

const theme = createTheme({
  palette: {
    mode: mode,
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

reportWebVitals();
