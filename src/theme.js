// theme.js

import { createSystem, defaultBaseConfig, defineConfig } from '@chakra-ui/react';
import { useEffect } from 'react';

// Define your theme configuration
const config = {
  initialColorMode: 'system',
  useSystemColorMode: true,
};

// Create a custom config using defineConfig
const customConfig = defineConfig({
  theme: {
    config,
    styles: {
      global: {
        body: {
          bg: 'var(--chakra-body-bg)',
        },
      },
    },
  },
});

// Create the styling system by merging defaultBaseConfig with your custom config.
// The returned "system" object has a property "theme" that is the actual theme object.
const system = createSystem(defaultBaseConfig, customConfig);

// A hook to sync Chakra UI's color mode with XenForo's theme dynamically.
export const useSyncChakraColorModeWithXenForo = () => {
  useEffect(() => {
    const syncColorMode = () => {
      const htmlElement = document.documentElement;
      const colorScheme = htmlElement.getAttribute('data-color-scheme');
      const variation = htmlElement.getAttribute('data-variation');

      let xenForoColorMode;
      if (colorScheme === 'light') {
        xenForoColorMode = 'light';
      } else if (colorScheme === 'dark' || variation === 'alternate') {
        xenForoColorMode = 'dark';
      } else {
        // Default to 'light' if no explicit setting is found.
        xenForoColorMode = 'light';
      }

      document.documentElement.classList.toggle(
        'dark',
        xenForoColorMode === 'dark'
      );
    };

    window.addEventListener('load', syncColorMode);

    const mutationObserver = new MutationObserver(syncColorMode);
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-variation', 'data-color-scheme'],
    });

    return () => {
      window.removeEventListener('load', syncColorMode);
      mutationObserver.disconnect();
    };
  }, []);
};

export { config };
export default system;
