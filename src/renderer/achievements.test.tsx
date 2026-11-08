import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GameAchievement } from '../shared/types';
import { AchievementCard, achievementList, achievementSummary, AchievementsContent, AchievementsDialog } from './Achievements';
const item = (patch: Partial<GameAchievement> = {}): GameAchievement => ({ id: 'sample:1', name: 'First step', description: 'Finish a level', secret: false, revoked: false, state: 'unlocked', gamerscore: 10, unlockedAt: '2026-01-01T12:00:00Z', ...patch });
it('summarizes known values without inventing missing gamerscore and sorts unlocks by date', () => {
  const items=[item(),item({id:'sample:2',state:'locked',unlockedAt:undefined,gamerscore:20}),item({id:'sample:3',unlockedAt:'2026-01-02T12:00:00Z'})];
  expect(achievementSummary(items)).toEqual({earned:2,count:3,score:'20 / 40 G'});
  expect(achievementSummary([item({gamerscore:undefined})]).score).toBeUndefined();
  expect(achievementList(items,'unlocked').map(item=>item.id)).toEqual(['sample:3','sample:1']);
  expect(achievementList(items,'locked').map(item=>item.id)).toEqual(['sample:2']);
  expect(items[0].id).toBe('sample:1');
});
it('does not put locked secret names, descriptions or images into the rendered DOM', () => {
  const html=renderToStaticMarkup(<AchievementCard item={item({state:'locked',unlockedAt:undefined,secret:true,name:'Secret story spoiler',description:'Secret ending',iconUrl:'https://images-eds-ssl.xboxlive.com/spoiler'})}/>);
  for(const leak of ['Secret story spoiler','Secret ending','xboxlive.com/spoiler'])expect(html).not.toContain(leak);
  expect(html).toContain('Secret achievement');expect(html).toContain('Reveal details');
});
it('displays genuinely unlocked secret details and escapes server text', () => {
  const html=renderToStaticMarkup(<AchievementCard item={item({secret:true,name:'<script>name</script>',description:'<img src=x>'})}/>);
  expect(html).toContain('&lt;script&gt;name&lt;/script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('Unlocked');expect(html).not.toContain('Reveal details');
});
it.each(['unavailable','unsupported','signed-out','error'] as const)('shows an honest %s state without fake totals', status => {
  const html=renderToStaticMarkup(<AchievementsContent title="Game" value={{status}} loading={false} refresh={()=>{}}/>);
  expect(html).toContain('Achievements');expect(html).not.toContain('0 / 0');expect(html).not.toContain('View all');
  if(status==='unsupported')expect(html).toContain('Update the backend');
});
it('labels a partial list rather than presenting loaded counts as the complete game total', () => {
  const html=renderToStaticMarkup(<AchievementsContent title="Game" value={{status:'available',partial:true,items:[item()]}} loading={false} refresh={()=>{}}/>);
  expect(html).toContain('1 unlocked in 1 loaded');expect(html).toContain('loaded achievements only');expect(html).toContain('View all 1');
});
it('makes the full list a B-closeable modal without the removed read-only footnote', () => {
  const html=renderToStaticMarkup(<AchievementsDialog title="Game" value={{status:'available',items:[item()]}} close={()=>{}}/>);
  expect(html).toContain('role="dialog"');expect(html).toContain('aria-modal="true"');expect(html).toContain('data-gamepad-cancel');expect(html).toContain('Filter achievements');
  for(const label of ['All achievements','Unlocked','Locked'])expect(html).toContain(label);
  const section=renderToStaticMarkup(<AchievementsContent title="Game" value={{status:'available',items:[item()]}} loading={false} refresh={()=>{}}/>);
  expect(section).not.toContain('Read-only Xbox progress');
});
