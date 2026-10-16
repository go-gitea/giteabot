import {nodeLib} from 'tsdown-config-silverwind';
import {defineConfig} from 'tsdown';

export default defineConfig(nodeLib({
  url: import.meta.url,
  entry: {index: 'src/action.ts'},
  dts: false,
  deps: {alwaysBundle: [/./]}, // the action runs without installing dependencies
}));
