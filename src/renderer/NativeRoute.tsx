import {lazy, StrictMode, Suspense} from 'react';
import App from './App';

const Chat = lazy(() => import('./native-windows/chat').then(module => ({default: module.render})));
const Party = lazy(() => import('./native-windows/party').then(module => ({default: module.render})));

export function NativeRoute({route}:{route:string}) {
  // Validate before loading a native window. Unrecognized hashes still open Nexus.
  const native = /^#xbox-chat=[1-9][0-9]{0,19}$/.test(route) ? <Chat route={route}/>
    : route === '#xbox-media' ? <Party route={route}/> : undefined;
  return native ? <Suspense fallback={null}>{native}</Suspense> : <StrictMode><App/></StrictMode>;
}
