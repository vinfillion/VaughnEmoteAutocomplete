// Minimal DOM stub to exercise the virtual-click loader logic.
class Node { constructor(tag){ this.tagName=tag; this.children=[]; this.attrs={}; this.style={removeProperty(){},setProperty(){}}; Object.defineProperty(this,'className',{get(){return this.attrs['class']||'';}}); Object.defineProperty(this,'ownerDocument',{get(){return globalThis.document;}}); }
  getAttribute(n){return this.attrs[n]??null;} setAttribute(n,v){this.attrs[n]=v;}
  addEventListener(t,f){ if(t==='click') globalThis.__recorded(this); }
  closest(){ return null; } getBoundingClientRect(){ return {left:0,top:0,width:20,height:20,bottom:20,right:20}; }
  focus(){} click(){ globalThis.__clicked(this.attrs['class']); }
  appendChild(c){ this.children.push(c); }
}
globalThis.Node = Node;


globalThis.PointerEvent = class {}; globalThis.MouseEvent = class { constructor(t,o){Object.assign(this,{type:t,...o});} };
globalThis.KeyboardEvent = class {};

const recorded = new Set();
globalThis.__recorded = (el)=>recorded.add(el);
const clicked = [];
globalThis.__clicked = (el)=>clicked.push(el.className);

// fake document
const btnEmoji = new Node('BUTTON'); btnEmoji.setAttribute('class','vs_chatv9_emoji_button'); btnEmoji.setAttribute('title','Emojis');
btnEmoji.addEventListener('click', ()=>{}); // React-ish handler registration BEFORE hook? we simulate after hook
const body = new Node('body');
body.querySelectorAll = (sel)=> sel.includes('emoji_button') ? [btnEmoji] : [];
globalThis.document = { readyState:'complete', body, activeElement:body,
  querySelectorAll:(sel)=> sel.includes('emoji_button') ? [btnEmoji] : [],
  querySelector:(sel)=> null,
  createElement:()=>new Node('div'), addEventListener(){}, documentElement:new Node('html'), contains:()=>true };
globalThis.window = globalThis; globalThis.location = {href:'https://vaughn.live/x', origin:'https://vaughn.live', pathname:'/x'};
globalThis.getComputedStyle = ()=>({position:'absolute'});
globalThis.MutationObserver = class { observe(){} };
globalThis.EventTarget = Node; // for hookDocument proto patching


// Load content.js in this sandbox
require('/workspace/content.js');

setTimeout(()=>{
  console.log('clicked elements:', JSON.stringify(clicked));
  console.log('recorded listener targets size:', recorded.size, 'includes btn:', recorded.has(btnEmoji));
}, 12000);
