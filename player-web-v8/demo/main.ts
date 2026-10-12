import { createApp } from 'vue';
// The harness mounts the component directly rather than through the package
// entry, so the vendor stylesheets it would have imported are pulled in here —
// in the same order, for the same reason (see src/index.ts).
import 'video.js/dist/video-js.css';
import 'videojs-mobile-ui/dist/videojs-mobile-ui.css';
import '../src/styles.css';
import DemoApp from './DemoApp.vue';

createApp(DemoApp).mount('#app');
