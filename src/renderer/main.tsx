import {installTouchKeyboard} from './touch-keyboard';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './controls.css';
const windows=import.meta.glob<{render:(route:string)=>React.ReactNode}>('./native-windows/*.tsx',{eager:true});
installTouchKeyboard(window,field=>window.launcher.showTouchKeyboard(field));
function NativeView(){
 const [route,setRoute]=React.useState(window.location.hash);
 React.useEffect(()=>{const changed=()=>setRoute(window.location.hash);window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
 for(const view of Object.values(windows)){const content=view.render(route);if(content)return content;}
 return <React.StrictMode><App/></React.StrictMode>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<NativeView/>);
