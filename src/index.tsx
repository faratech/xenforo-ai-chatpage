import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import ScopedCssBaseline from '@mui/material/ScopedCssBaseline';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import './index.css';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

type ColorMode = 'light' | 'dark';

const resolveMode = (): ColorMode => {
  const xenforoMode = document.documentElement.getAttribute('data-color-scheme');
  if (xenforoMode === 'light' || xenforoMode === 'dark') return xenforoMode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const WF = {
  primary: '#0f6cbd',
  primaryHover: '#0c5aa0',
  accent: '#115ea3',
  pressed: '#07426f',
  light: {
    page: '#eff5f6', paper: '#ffffff', alt: '#f8fafb', border: '#ebebeb', text: '#1a1b1b', muted: '#5f6060', error: '#d9214e',
  },
  dark: {
    page: '#1f2021', paper: '#292929', alt: '#383a3a', border: '#44474a', text: '#ffffff', muted: '#cfcfcf', error: '#ff6b8a',
  },
};

const makeTheme = (mode: ColorMode) => {
  const colors = mode === 'dark' ? WF.dark : WF.light;
  return createTheme({
    palette: {
      mode,
      primary: { main: WF.primary, dark: WF.primaryHover, contrastText: '#ffffff' },
      secondary: { main: WF.accent, contrastText: '#ffffff' },
      background: { default: colors.page, paper: colors.paper },
      text: { primary: colors.text, secondary: colors.muted },
      divider: colors.border,
      success: { main: '#1f8a5b' },
      error: { main: colors.error },
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Segoe UI Variable", Roboto, "Helvetica Neue", Arial, "Inter", sans-serif',
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
          outlined: { borderColor: colors.border },
        },
      },
      MuiIconButton: { styleOverrides: { root: { borderRadius: 8 } } },
      MuiChip: { styleOverrides: { root: { borderRadius: 999, fontWeight: 500 } } },
      MuiDrawer: { styleOverrides: { paper: { backgroundImage: 'none', borderRight: `1px solid ${colors.border}` } } },
      MuiTooltip: { styleOverrides: { tooltip: { fontSize: 12, backgroundColor: WF.pressed } } },
    },
  });
};

const ThemedApp = () => {
  const [mode, setMode] = useState<ColorMode>(resolveMode);
  const theme = useMemo(() => makeTheme(mode), [mode]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const refresh = () => setMode(resolveMode());
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-scheme'] });
    media.addEventListener('change', refresh);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', refresh);
    };
  }, []);

  return (
    <ThemeProvider theme={theme}>
      {/* All baseline resets, theme tokens, and chat styling live on this
          wrapper — never on <html>/<body> — so the surrounding XenForo
          page is unaffected by the embed. */}
      <ScopedCssBaseline
        id="react-chat-container"
        data-wf-theme={mode}
        sx={{ backgroundColor: 'background.default', color: 'text.primary' }}
      >
        <App />
      </ScopedCssBaseline>
    </ThemeProvider>
  );
};

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemedApp />
    </ErrorBoundary>
  </React.StrictMode>
);
