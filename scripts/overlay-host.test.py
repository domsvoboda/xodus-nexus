#!/usr/bin/python3
"""Lifecycle regression checks for asynchronous native shelf reveal."""
import ast,json
from pathlib import Path
from types import SimpleNamespace
root=Path(__file__).resolve().parents[1]
source=(root/'assets/overlay/xbox_guide.py').read_text();tree=ast.parse(source)
run=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='run')
klass=next(n for n in run.body if isinstance(n,ast.ClassDef) and n.name=='Guide')
events=[];removed=[];keyboard=[]
env={'layered':True,'emit':lambda event,*_:events.append(('emit',event)),'GLib':SimpleNamespace(source_remove=lambda n:removed.append(n)),'GtkLayerShell':SimpleNamespace(set_keyboard_mode=lambda *_:keyboard.append('none'),KeyboardMode=SimpleNamespace(NONE=0,ON_DEMAND=1))}
exec(compile(ast.Module(body=[klass],type_ignores=[]),'source-guide-class','exec'),env)
Guide=env['Guide']
class Window:
 def __init__(self,visible=True):self.visible=visible
 def get_visible(self):return self.visible
 def hide(self):self.visible=False;events.append(('window','hide'))
class View:
 def __init__(self,error=False):self.error=error
 def call_async_javascript_function_finish(self,_):
  events.append(('finish',None))
  if self.error:raise RuntimeError('fake cancellation')
 def set_opacity(self,value):events.append(('opacity',value))
class Cancel:
 def cancel(self):events.append(('cancel',None))
def guide():
 events.clear();removed.clear();keyboard.clear();g=Guide.__new__(Guide);g.closing=False;g.ready=True;g.pending_show=True;g.show_generation=2;g.shelf_preparing=True;g.shelf_timeout=17;g.shelf_cancellable=Cancel();g.window=Window();g.webview=View();g.update_shelf=lambda v:events.append(('shelf',v));g.fail=lambda code:events.append(('fail',code));g.select_monitor=lambda:None;return g
passed=[]
g=guide();g.shelf_prepared(g.webview,None,1);assert events==[('finish',None)] and g.shelf_preparing and not removed;passed.append('obsolete-generation-cannot-reveal')
g=guide();g.pending_show=False;g.window.visible=False;g.shelf_prepared(g.webview,None,2);assert events==[('finish',None)] and not removed;passed.append('hidden-current-generation-cannot-reveal')
g=guide();g.shelf_prepared(g.webview,None,2);assert events==[('finish',None),('opacity',1),('shelf',True),('emit','shown')] and removed==[17] and not g.shelf_preparing and g.shelf_cancellable is None;passed.append('only-prepared-visible-generation-emits-shown')
g=guide();g.hide();assert not g.pending_show and not g.shelf_preparing and g.show_generation==3 and g.shelf_cancellable is None and removed==[17] and keyboard==['none'] and events==[('cancel',None),('window','hide'),('shelf',False)];g.shelf_prepared(g.webview,None,2);assert events[-1]==('finish',None) and not any(e[0]=='opacity' for e in events);passed.append('hide-cancels-timeout-releases-input-and-invalidates-callback')
g=guide();g.shelf_prepare_timed_out(1);assert not events and g.shelf_timeout==17;g.shelf_prepare_timed_out(2);assert events==[('fail','shelf-prepare-timeout')] and g.shelf_timeout==0;passed.append('only-current-preparation-can-time-out')
g=guide();g.show();assert not events and g.show_generation==2;passed.append('repeated-show-waits-for-one-preparation')
g=guide();g.shelf_prepared(View(True),None,1);assert events==[('finish',None)];g.shelf_prepared(View(True),None,2);assert events[-1]==('fail','shelf-prepare-failed');passed.append('current-api-failure-fails-closed-stale-cancellation-does-not')
g=guide();g.shelf_preparing=False;g.focus_lost();assert not g.pending_show and not g.window.visible;passed.append('lost-focus-hides-overlay')
env['layered']=False;g=guide();g.hide();assert not keyboard and not g.pending_show;passed.append('desktop-fallback-does-not-call-layer-shell')
print(json.dumps({'passed':True,'cases':passed}))
