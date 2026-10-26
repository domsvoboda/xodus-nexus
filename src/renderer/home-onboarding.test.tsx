import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {demoSnapshot} from '../shared/demo-data';
import {HomePage} from './App';
it('uses real library highlights instead of duplicating sidebar shortcuts',()=>{
 const data=demoSnapshot(),html=renderToStaticMarkup(<HomePage data={data} go={()=>{}} action={()=>{}} />);
 expect(html).toContain('home-highlights');expect(html).toContain('Recently added');
 expect(html).not.toContain('Quick access');expect(html).not.toContain('quick-grid');
 expect(html).toContain(data.games[0].title);
});
