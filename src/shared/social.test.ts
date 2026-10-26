import { describe,expect,it } from 'vitest';
import { parseXboxFriends,parseXboxConversation,parseXboxMessageReceipt,xboxSubmissionInHistory,xboxUserId,xboxMessageText,xboxAvatarUrl,xboxSocialError,xboxSocialErrors } from './social.js';
const friend={xuid:'42',gamertag:'<Example>',presence:'online',activity:'A game'};
const message={id:'one',sender:'42',at:'2026-10-25T00:00:00Z',hidden:false,text:'<script>plain</script>'};
describe('Xbox social boundaries',()=>{
  it('keeps a real receipt without claiming delivery and rejects legacy boolean-only success',()=>{
    expect(parseXboxMessageReceipt({sent:true,messageId:'server-id',private:'ignored'})).toEqual({messageId:'server-id'});
    for(const value of [null,{sent:true},{sent:false,messageId:'id'},{sent:true,messageId:42},{sent:true,messageId:''},{sent:true,messageId:' '},{sent:true,messageId:'x'.repeat(129)},{sent:true,messageId:'bad\n'}])
      expect(()=>parseXboxMessageReceipt(value)).toThrow('could not be confirmed');
  });
  it('reconciles only the exact server ID from the outgoing side, not equal text or any fresh read',()=>{
    const receipt={messageId:'accepted'};
    const thread={xuid:'42',hasMore:false,messages:[message]};
    expect(xboxSubmissionInHistory(receipt,thread)).toBe(false);
    expect(xboxSubmissionInHistory(receipt,{...thread,messages:[{...message,id:'accepted'}]})).toBe(false);
    expect(xboxSubmissionInHistory(receipt,{...thread,messages:[{...message,id:'other',sender:'43'}]})).toBe(false);
    expect(xboxSubmissionInHistory(receipt,{...thread,messages:[{...message,id:'accepted',sender:'43'}]})).toBe(true);
    expect(xboxSubmissionInHistory(receipt,{...thread,messages:[]})).toBe(false);
  });
  it('keeps only allowlisted HTTPS profile pictures and never arbitrary remote URLs',()=>{
    for(const value of ['https://images-eds-ssl.xboxlive.com/image','https://gamerpic.xboxlive.com/avatar.png'])expect(xboxAvatarUrl(value)).toBe(value);
    for(const value of ['https://images-eds-ssl.xboxlive.com.evil.test/a','http://gamerpic.xboxlive.com/a','https://secret@gamerpic.xboxlive.com/a','file:///tmp/a','data:image/svg+xml,<svg/>','https://127.0.0.1/a','https://gamerpic.xboxlive.com:8443/a',null])expect(xboxAvatarUrl(value)).toBeUndefined();
    expect(parseXboxFriends({friends:[{...friend,avatarUrl:'https://gamerpic.xboxlive.com/a'}]})[0].avatarUrl).toBe('https://gamerpic.xboxlive.com/a');
    expect(parseXboxFriends({friends:[{...friend,avatarUrl:'https://evil.test/a'}]})[0].avatarUrl).toBeUndefined();
  });
  it('shows only fixed actionable errors, including Electron IPC prefixes',()=>{
    for(const safe of Object.values(xboxSocialErrors)){
      expect(xboxSocialError(Error(safe))).toBe(safe);
      expect(xboxSocialError(Error(`Error invoking remote method 'xbox-conversation': Error: ${safe}`))).toBe(safe);
    }
    for(const raw of ['PRIVATE_TOKEN',xboxSocialErrors.denied+' private@example.test',`prefix ${xboxSocialErrors.denied}`])expect(xboxSocialError(Error(raw))).toBe(xboxSocialErrors.unavailable);
  });
  it.each(['0','01','-1','18446744073709551616','42/../../','42?token=x',42,null,''])('rejects invalid user %s',v=>expect(xboxUserId(v)).toBe(false));
  it.each(['1','42','18446744073709551615'])('keeps uint64 user %s lossless',v=>expect(xboxUserId(v)).toBe(true));
  it('validates message text by Unicode code points and never accepts controls or empty text',()=>{
    expect(xboxMessageText('🐱'.repeat(256))).toBe(true);expect(xboxMessageText('🐱'.repeat(257))).toBe(false);
    for(const v of ['',' \n\t','secret\0','secret\r','bad\u001b',null])expect(xboxMessageText(v)).toBe(false);
    expect(xboxMessageText('first\nsecond\t🐱')).toBe(true);
  });
  it('projects only friend fields and preserves unknown presence without inventing online state',()=>{
    expect(parseXboxFriends({friends:[{...friend,token:'private',realName:'private'}]})).toEqual([friend]);
    expect(parseXboxFriends({friends:[{...friend,presence:'unknown'}]})[0].presence).toBe('unknown');
    for(const value of [{friends:[friend,friend]},{friends:[{...friend,presence:'Away'}]},{friends:[{...friend,activity:{}}]},{friends:Array(1001).fill(friend)},null])expect(()=>parseXboxFriends(value)).toThrow();
  });
  it('removes filtered message text before any renderer can receive it and sorts by timestamp',()=>{
    const result=parseXboxConversation({xuid:'42',hasMore:true,messages:[{...message,id:'two',at:'2026-10-26T00:00:00Z',hidden:true,text:'FILTERED'},message]},'42');
    expect(result.messages.map(x=>x.id)).toEqual(['one','two']);expect(JSON.stringify(result)).not.toContain('FILTERED');
    expect(result.messages[0].text).toContain('<script>');expect(result.hasMore).toBe(true);
  });
  it('rejects mismatched, malformed, duplicate and oversized conversations',()=>{
    for(const v of [{xuid:'43',hasMore:false,messages:[]},{xuid:'42',hasMore:false,messages:[message,message]},
      {xuid:'42',hasMore:false,messages:[{...message,at:'not-a-date'}]}, {xuid:'42',hasMore:false,messages:[{...message,sender:42}]},
      {xuid:'42',hasMore:false,messages:[{...message,text:'bad\0'}]}, {xuid:'42',hasMore:false,messages:Array(101).fill(message)}])expect(()=>parseXboxConversation(v,'42')).toThrow();
  });
});
