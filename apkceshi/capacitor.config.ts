import type { CapacitorConfig } from '@capacitor/cli';

/// <reference types="@capacitor/background-runner" />

const config: CapacitorConfig = {
  appId: 'studio.zaichang.mobile',
  appName: '在场',
  webDir: 'dist',
  android: {
    backgroundColor: '#101614',
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    CapacitorCookies: {
      enabled: true,
    },
    BackgroundRunner: {
      label: 'studio.zaichang.mobile.campus-sync',
      src: 'runners/campus-sync.js',
      event: 'campusSync',
      repeat: true,
      interval: 15,
      autoStart: false,
    },
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#101614',
      showSpinner: false,
    },
  },
};

export default config;
