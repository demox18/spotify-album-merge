import './styles.css';
import { startApp } from './ui/app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Manca #app');
startApp(root);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const base = new URL('./', window.location.href);
  void navigator.serviceWorker.register(new URL('sw.js', base).href, { scope: base.pathname }).catch(() => undefined);
}
