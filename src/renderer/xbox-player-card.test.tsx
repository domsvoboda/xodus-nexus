import {useState} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import type {XboxPlayerDetails,XboxSocialApi} from '../shared/types';
import {XboxPlayerCard} from './XboxPlayerCard';

vi.mock('react',async()=>{
 const actual=await vi.importActual<typeof import('react')>('react');
 return {...actual,useState:vi.fn(actual.useState)};
});

it.each([
 [false,'0'],[false,'123456789'],[true,'0'],[true,'123456789'],
])('omits tenure from player profiles (expanded=%s, tenure=%s)',(expanded,tenure)=>{
 const profile:XboxPlayerDetails={xuid:'1',gamertag:'Synthetic player',gamerscore:'42',isSelf:true,bio:'Profile biography',location:'Profile location',tenure};
 vi.mocked(useState).mockImplementationOnce((()=>[profile,vi.fn()]) as typeof useState);
 const html=renderToStaticMarkup(<XboxPlayerCard api={{} as XboxSocialApi} account="fixture" xuid="me" expanded={expanded} chat={()=>{}} back={()=>{}}/>);
 expect(html).toContain('Synthetic player');expect(html).toContain('42 Gamerscore');
 expect(html).toContain('Profile biography');expect(html).toContain('Profile location');
 expect(html).not.toMatch(/tenure|123456789/i);
});
