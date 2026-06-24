import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { ErrorBoundary } from './components/ErrorBoundary';

// Check XenForo's light/dark setting (XF 2.3 uses data-color-scheme on <html>)
const xenforoColorScheme = document.documentElement.getAttribute('data-color-scheme');
// If XenForo's attribute is not present, fall back to system preference.
const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const mode: 'light' | 'dark' = xenforoColorScheme === 'dark' ? 'dark' : xenforoColorScheme === 'light' ? 'light' : systemPrefersDark ? 'dark' : 'light';

// Expose the resolved mode to CSS so the WindowsForum design tokens in App.css
// track MUI's palette exactly (independent of the OS-level media query).
document.documentElement.setAttribute('data-wf-theme', mode);

// WindowsForum.com design-system palette (Fluent-adjacent).
const WF = {
  primary: '#0f6cbd',      // lead Windows blue
  primaryHover: '#0c5aa0',
  accent: '#115ea3',       // CTA / selected
  pressed: '#07426f',
  light: {
    page: '#eff5f6',
    paper: '#ffffff',
    alt: '#f8fafb',
    border: '#ebebeb',
    text: '#1a1b1b',
    muted: '#5f6060',
  },
  dark: {
    page: '#1f2021',
    paper: '#292929',
    alt: '#383a3a',
    border: '#272729',
    text: '#ffffff',
    muted: '#cfcfcf',
  },
};

const c = mode === 'dark' ? WF.dark : WF.light;

const theme = createTheme({
  palette: {
    mode,
    primary: { main: WF.primary, dark: WF.primaryHover, contrastText: '#ffffff' },
    secondary: { main: WF.accent, contrastText: '#ffffff' },
    background: { default: c.page, paper: c.paper },
    text: { primary: c.text, secondary: c.muted },
    divider: c.border,
    success: { main: '#1f8a5b' },
    error: { main: '#d9214e' },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Segoe UI Variable", Roboto, "Helvetica Neue", Arial, "Inter", sans-serif',
    fontSize: 15,
    button: { textTransform: 'none', fontWeight: 600 },
    h6: { fontWeight: 700, fontSize: '1rem' },
    subtitle2: { fontWeight: 700 },
  },
  components: {
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 600, borderRadius: 8 },
        outlined: { borderColor: c.border },
      },
    },
    MuiIconButton: { styleOverrides: { root: { borderRadius: 8 } } },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 999, fontWeight: 500 },
      },
    },
    MuiDrawer: {
      styleOverrides: { paper: { backgroundImage: 'none', borderRight: `1px solid ${c.border}` } },
    },
    MuiTooltip: {
      styleOverrides: { tooltip: { fontSize: 12, backgroundColor: WF.pressed } },
    },
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
