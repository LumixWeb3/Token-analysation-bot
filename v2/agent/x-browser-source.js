'use strict';

const {buildXSource}=require('./x-evidence');
// Serialized into a read-only DOM scope; only public mounted posts are read.
function readXDom(){
  const originalText=node=>{
    if(node.nodeType===3)return node.textContent;
    if(node.nodeType!==1)return '';
    if(node.tagName==='IMG')return node.getAttribute('alt')??'';
    if(node.tagName==='BR')return '\n';
    return Array.from(node.childNodes).map(originalText).join('');
  };
  const pageUrl=document.URL,articles=Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const tweets=articles.map(article=>{
    const time=article.querySelector('time'),anchor=time?.closest('a[href]'),href=anchor?.getAttribute('href');
    let url=null;try{url=new URL(href,pageUrl).href;}catch{}
    const match=url&&/^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\?.*)?$/.exec(url);
    const content=article.querySelector('[data-testid="tweetText"]');
    return{id:match?.[2]??null,url,author:{handle:match?.[1]??null},date:time?.getAttribute('datetime')??null,
      text:content?originalText(content):'',text_complete:!article.querySelector('[data-testid="tweet-text-show-more-link"]'),
      urls:Array.from(content?.querySelectorAll('a[href]')??[]).map(a=>({url:a.getAttribute('href'),expanded_url:null,display_url:a.textContent})),
      likes:null,retweets:null,replies:null,quotes:null,views:null,
      coverage:'Mounted article text only; unknown engagement is null. Images/video, hidden threads and linked webpages have not been inspected.'};
  });
  const bio=/^\/[A-Za-z0-9_]{1,15}\/?$/.test(new URL(pageUrl).pathname)?document.querySelector('[data-testid="UserDescription"]'):null;
  return{ok:articles.length>0,source_page_url:pageUrl,tweets,
    profile_bio_text:bio?originalText(bio):null,profile_bio_coverage:'VISIBLE_PROFILE_DESCRIPTION_ONLY; linked pages and full media not inspected.',
    community_id:/\/i\/communities\/(\d+)/.exec(pageUrl)?.[1]??null,
    query:new URL(pageUrl).searchParams.get('q'),coverage:'MOUNTED_ARTICLES_ONLY'};
}
async function collectXFromPage({page,request,now=()=>Date.now()}={}){
  if(!page?.evaluate)throw Error('CALLER_OWNED_X_PAGE_REQUIRED');
  const started=new Date(now()).toISOString(),raw=await page.evaluate(readXDom);
  return buildXSource({request,raw,capture_started_at:started,collected_at:new Date(now()).toISOString(),
    source_page_url:raw.source_page_url,transport:'BROWSER_DOM'});
}
module.exports={readXDom,collectXFromPage};
