import { createApp } from 'vue';
import { appPluginsManager } from '@/build-time/contracts/plugin-registry';
import App from './App.vue';
import './styles.css';

createApp(App).use(appPluginsManager).mount('#app');
