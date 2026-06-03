/**
 * @format
 */

// Polyfill Buffer for Hermes (atob/btoa not available in React Native JS engine)
global.Buffer = require('buffer').Buffer;

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
