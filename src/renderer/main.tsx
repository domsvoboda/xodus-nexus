import {installTouchKeyboard} from './touch-keyboard';
import React from 'react';
import ReactDOM from 'react-dom/client';
import {NativeRoute} from './NativeRoute';
import './styles.css';
import './controls.css';
installTouchKeyboard(window,field=>window.launcher.showTouchKeyboard(field));
function NativeView(){
 const [route,setRoute]=React.useState(window.location.hash);
 React.useEffect(()=>{const changed=()=>setRoute(window.location.hash);window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
 return <NativeRoute route={route}/>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<NativeView/>);
