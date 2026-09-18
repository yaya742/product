import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'studio.zaichang.mobile',
  appName: '在场',
  webDir: 'dist',
  android: {
    backgroundColor: '#101614',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#101614',
      showSpinner: false,
    },
  },
};

export default config;
