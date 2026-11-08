import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {demoSnapshot} from '../shared/demo-data';
import {HomePage} from './App';
it('uses real library highlights instead of duplicating sidebar shortcuts',()=>{
 const data=demoSnapshot(),html=renderToStaticMarkup(<HomePage data={data} go={()=>{}} action={()=>{}} />);
 expect(html).toContain('home-highlights');expect(html).toContain('Recently installed');expect(html).toContain('Recently added in Game Pass');
 expect(html).not.toContain('Quick access');expect(html).not.toContain('quick-grid');
 expect(html).toContain(data.games[0].title);
});
it('does not render the generic compatibility banner',()=>{
 const data=demoSnapshot(),html=renderToStaticMarkup(<HomePage data={data} go={()=>{}} action={()=>{}} />);
 expect(html).not.toContain('Compatibility status');
 expect(html).not.toContain('Package ownership and installation do not guarantee');
});
