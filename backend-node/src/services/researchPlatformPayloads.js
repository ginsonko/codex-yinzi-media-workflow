'use strict';
const count = value => {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).replace(/,/g, '').trim();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([万亿kKmMbB])?$/);
  if (!match) return null;
  const n = Number(match[1]) * ({万:1e4,亿:1e8,k:1e3,m:1e6,b:1e9}[match[2]?.toLowerCase()] || 1);
  return Number.isSafeInteger(Math.floor(n)) && n >= 0 ? Math.floor(n) : null;
};
const time = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n < 1e12 ? n * 1000 : n);
  return Number.isFinite(+d) ? d.toISOString() : null;
};
const plain = value => String(value ?? '').replace(/<[^>]+>/g, '').slice(0,500);
const youtubeText = value => value?.simpleText || value?.runs?.map(x=>x.text).join('') || '';
function normalizeRecord(platform, raw, observedAt) {
  let id, url, title, author, published, duration, stats, followers, description;
  if (platform === 'douyin' && raw.aweme_id && (raw.desc != null || raw.statistics)) {
    id = String(raw.aweme_id); url = `https://www.douyin.com/video/${id}`;
    title = raw.desc; author = raw.author?.nickname; followers=count(raw.author?.follower_count)>0?count(raw.author.follower_count):null;
    published=time(raw.create_time); duration=raw.video?.duration != null ? Number(raw.video.duration)/1000 : null;
    const s=raw.statistics || {};
    // The public Douyin response commonly suppresses play_count as zero.
    stats={views:count(s.play_count)>0?count(s.play_count):null,likes:count(s.digg_count),comments:count(s.comment_count),shares:count(s.share_count),saves:count(s.collect_count)};
  } else if (platform === 'tiktok' && (raw.id || raw.itemId) && raw.stats && raw.author) {
    id=String(raw.id || raw.itemId); url=`https://www.tiktok.com/@${encodeURIComponent(raw.author.uniqueId || '_')}/video/${id}`;
    title=raw.desc; author=raw.author.nickname || raw.author.uniqueId; published=time(raw.createTime); duration=count(raw.video?.duration); followers=count(raw.authorStats?.followerCount);
    stats={views:count(raw.stats.playCount),likes:count(raw.stats.diggCount),comments:count(raw.stats.commentCount),shares:count(raw.stats.shareCount),saves:count(raw.stats.collectCount)};
  } else if (platform === 'xiaohongshu' && (raw.note_id || raw.id) && (raw.note_card || raw.interact_info || raw.interactInfo)) {
    const n=raw.note_card || raw; id=String(raw.note_id || raw.id); url=`https://www.xiaohongshu.com/explore/${id}`;
    title=n.display_title || n.title || n.desc; description=n.desc; author=n.user?.nickname || n.user?.nick_name; published=time(n.time || n.publish_time); duration=count(n.video?.capa?.duration || n.video?.duration);
    const s=n.interact_info || n.interactInfo || {};
    stats={views:null,likes:count(s.liked_count ?? s.likedCount),comments:count(s.comment_count ?? s.commentCount),shares:count(s.share_count ?? s.shareCount),saves:count(s.collected_count ?? s.collectedCount)};
  } else if (platform === 'bilibili' && raw.bvid && raw.title) {
    id=raw.bvid; url=`https://www.bilibili.com/video/${id}/`; title=raw.title; author=raw.owner?.name || raw.author; published=time(raw.pubdate || raw.created); description=raw.desc;
    duration=typeof raw.duration==='number'?raw.duration:typeof raw.duration==='string'&&/^\d+:\d+$/.test(raw.duration)?raw.duration.split(':').reduce((a,x)=>a*60+Number(x),0):null;
    const s=raw.stat || {};
    stats={views:count(s.view ?? raw.play),likes:count(s.like ?? raw.like),comments:count(s.reply ?? raw.review),shares:count(s.share),saves:count(s.favorite ?? raw.favorites)};
  } else if (platform === 'youtube' && raw.videoId && (raw.title || raw.shortDescription)) {
    id=raw.videoId; url=`https://www.youtube.com/watch?v=${id}`; title=typeof raw.title==='string'?raw.title:youtubeText(raw.title);
    author=typeof raw.author==='string'?raw.author:youtubeText(raw.ownerText || raw.shortBylineText); description=raw.shortDescription;
    duration=count(raw.lengthSeconds); if(duration===null){const s=youtubeText(raw.lengthText);if(/^\d+(?::\d+){1,2}$/.test(s))duration=s.split(':').reduce((a,x)=>a*60+Number(x),0);}
    const view=raw.viewCount ?? youtubeText(raw.viewCountText).replace(/\s*(?:次观看|次觀看|次播放|views?)\s*$/i,'');
    stats={views:count(view),likes:null,comments:null,shares:null,saves:null}; published=null;
  } else return null;
  if (!/^[\w-]{5,100}$/.test(id) || !title) return null;
  return {id:`${platform}-${id}`,platform,url,title:plain(title),description:plain(description),author:plain(author),author_followers:followers??null,published_at:published,observed_at:observedAt,region:null,content_kind:raw.aweme_type===68?'image_post':'video',duration_seconds:Number.isFinite(duration)&&duration>0?duration:null,
    metrics:stats,evidence:{kind:'platform_page',url,note:'本机专用浏览器读取官方页面返回的公开内容字段；非成交数据'},analysis_basis:'metadata_only',selected:false};
}
function parsePayload(platform, payload, {observedAt=new Date().toISOString(),limit=200}={}) {
  const queue=[payload], seen=new Set(), items=new Map(), comments=[];
  let visited=0;
  while(queue.length && visited++<30000) {
    const node=queue.shift();if(!node||typeof node!=='object'||seen.has(node))continue;seen.add(node);
    const item=normalizeRecord(platform,node,observedAt);
    if(item && items.size<limit) {
      const previous=items.get(item.id);
      if(!previous || Object.values(item.metrics).filter(v=>v!=null).length>Object.values(previous.metrics).filter(v=>v!=null).length)items.set(item.id,item);
    }
    const cid=node.cid || node.comment_id;
    if(cid && typeof (node.text || node.content)==='string' && comments.length<100)comments.push({id:String(cid),text:plain(node.text || node.content),likes:count(node.digg_count ?? node.like_count),video_id:node.aweme_id?String(node.aweme_id):null,observed_at:observedAt});
    for(const value of Object.values(node))if(value&&typeof value==='object')queue.push(value);
  }
  return {items:[...items.values()],comments};
}
module.exports={count,time,normalizeRecord,parsePayload};
