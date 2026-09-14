(function (job) {
    var started = new Date().getTime(), undo = false, output = new Folder(job.output_dir);
    var result = {request_sha256:job.request_sha256, version:app.version, outputs:[], layer_count:0, keyframe_count:0, open_count:0};
    function quote(v) { return '"'+String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n').replace(/\t/g,'\\t')+'"'; }
    function json(v) { var a=[],k; if(v===null || typeof v==='undefined')return 'null'; if(typeof v==='string')return quote(v); if(typeof v==='number'||typeof v==='boolean')return String(v); if(v instanceof Array){for(k=0;k<v.length;k++)a.push(json(v[k]));return '['+a.join(',')+']';}for(k in v)if(v.hasOwnProperty(k))a.push(quote(k)+':'+json(v[k]));return '{'+a.join(',')+'}'; }
    function saveReceipt() {result.elapsed_seconds=(new Date().getTime()-started)/1000;var f=new File(output.fsName+'/ae-receipt.json');f.encoding='UTF-8';if(!f.open('w'))throw Error('Cannot write receipt');f.write(json(result));f.close();}
    function property(root, route) {var p=root;for(var k=0;k<route.length;k++){p=p.property(route[k]);if(!p)throw Error('Property missing: '+route.join('/'));}return p;}
    function shape(s) {var v=new Shape();v.vertices=s.vertices;var zeros=[];for(var i=0;i<s.vertices.length;i++)zeros.push([0,0]);v.inTangents=s.inTangents||zeros;v.outTangents=s.outTangents||zeros;v.closed=s.closed!==false;return v;}
    function value(v) {return v && v.vertices ? shape(v) : v;}
    function apply(root, specs) {for(var a=0;a<(specs||[]).length;a++){var s=specs[a],p=property(root,s.path);if(s.value!==undefined)p.setValue(value(s.value));for(var b=0;b<(s.keys||[]).length;b++){var k=s.keys[b];p.setValueAtTime(k.time,value(k.value));result.keyframe_count++;}for(var b=0;b<(s.keys||[]).length;b++){var k=s.keys[b],n=p.nearestKeyIndex(k.time);if(k.interpolation==='hold')p.setInterpolationTypeAtKey(n,KeyframeInterpolationType.HOLD);else if(k.influence!==undefined){var e=[],count=p.keyInTemporalEase(n).length;for(var z=0;z<count;z++)e.push(new KeyframeEase(0,k.influence));p.setTemporalEaseAtKey(n,e,e);}if(k.inTangent&&k.outTangent)p.setSpatialTangentsAtKey(n,k.inTangent,k.outTangent);}}}
    function uniqueItem(name) {var found=null;for(var k=1;k<=app.project.numItems;k++)if(app.project.item(k).name===name){if(found)throw Error('Ambiguous item '+name);found=app.project.item(k);}if(!found)throw Error('Item missing '+name);return found;}
    function inspectProps(root,depth) {var a=[];if(depth<0)return a;for(var k=1;k<=root.numProperties;k++){var p=root.property(k),o={index:k,name:p.name,matchName:p.matchName};if(p.propertyType===PropertyType.PROPERTY){o.keys=p.numKeys;try{o.value=p.value;}catch(e){}}else if(depth>0)o.children=inspectProps(p,depth-1);a.push(o);}return a;}
    function snapshot() {return {items:app.project.numItems,dirty:app.project.dirty,file:app.project.file?app.project.file.fsName:null};}
    function sameProject(p) {
        if(!p||!app.project.file)return false;
        var a=String(app.project.file.fsName).replace(/\\/g,'/'),b=String(new File(p).fsName).replace(/\\/g,'/');
        if(typeof $!=='undefined'&&/^Windows/i.test($.os)){a=a.toLowerCase();b=b.toLowerCase();}
        return a===b;
    }
    function protectCurrent() {
        if(!(app.project.numItems>0||app.project.file||app.project.dirty))return;
        if(!job.preserve_current)throw Error('AE_PROJECT_BUSY: inspect first; preserve_current saves a recovery copy');
        var recovery=new File(output.fsName+'/ae-previous-project.aep');if(recovery.exists)throw Error('Recovery path already exists');
        app.project.save(recovery);
        if(!recovery.exists)throw Error('Recovery project was not saved');
        result.recovery_project=recovery.fsName;
    }
    function openProjectOnce() {
        result.before_opened=snapshot();
        app.open(new File(job.open_project));result.open_count++;
        if(!sameProject(job.open_project))throw Error('Target project did not open');
        result.opened_project=job.open_project;
    }
    function applyRenderResolution(rq, comp, factor) {
        result.requested_resolution_factor=factor;
        comp.resolutionFactor=factor;result.preview_resolution_factor=comp.resolutionFactor;
        rq.setSettings({Resolution:{x:factor[0],y:factor[1]}});
        var actual=rq.getSettings(GetSettingsFormat.NUMBER).Resolution;
        result.applied_resolution_factor=actual?{x:actual.x,y:actual.y}:null;
        if(!actual||actual.x!==factor[0]||actual.y!==factor[1])throw Error('Render resolution readback does not match requested factors');
        result.render_settings=rq.getSettings(GetSettingsFormat.STRING);
        result.render_resolution=result.render_settings.Resolution;
        result.expected_output_size=[Math.ceil(comp.width/factor[0]),Math.ceil(comp.height/factor[1])];
        // Output-module transforms would otherwise override the requested pixel size.
        var om=rq.outputModule(1);om.setSettings({Resize:false,Crop:false});
        var settings=rq.outputModule(1).getSettings(GetSettingsFormat.NUMBER);
        if(settings.Resize!==false||settings.Crop!==false)throw Error('Output module resize/crop could not be disabled');
    }
    try {
        if(!output.exists&&!output.create())throw Error('Output directory unavailable');
        result.before=snapshot();
        var targetAlreadyLoaded=sameProject(job.open_project);
        if(app.project.renderQueue&&app.project.renderQueue.rendering&&(job.mode!=='inspect'||(job.open_project&&!targetAlreadyLoaded)))throw Error('AE_RENDER_BUSY: wait for the active render');
        if(job.mode==='inspect') {
            if(job.open_project&&!targetAlreadyLoaded){protectCurrent();openProjectOnce();}
            else if(job.open_project){result.opened_project=job.open_project;result.open_skipped_already_loaded=true;}
            result.items=[];for(var q=1;q<=app.project.numItems;q++){var it=app.project.item(q);result.items.push({name:it.name,type:it.typeName,layers:it instanceof CompItem?it.numLayers:null});}
            result.effects=[];for(var q=0;q<app.effects.length;q++)result.effects.push({name:app.effects[q].displayName,matchName:app.effects[q].matchName});
            if(job.inspect&&job.inspect.comp){var ic=uniqueItem(job.inspect.comp),root=ic.layer(job.inspect.layer);if(job.inspect.path)root=property(root,job.inspect.path);result.properties=inspectProps(root,Math.min(4,job.inspect.depth||1));}
            result.status='inspected';saveReceipt();return;
        }
        var projectFile=new File(output.fsName+'/project.aep');if(projectFile.exists)throw Error('Project output already exists');
        protectCurrent();
        if(job.open_project){
            if(targetAlreadyLoaded){result.opened_project=job.open_project;result.open_skipped_already_loaded=true;}
            else openProjectOnce();
        }else app.newProject();
        var targetReady=true;
        app.beginUndoGroup('Yinzi structured AE job');undo=true;
        if(job.bits_per_channel)app.project.bitsPerChannel=job.bits_per_channel;
        var items={},assets=job.assets||[],comps=job.comps||[];
        for(var i=0;i<assets.length;i++){var a=assets[i];items[a.id]=app.project.importFile(new ImportOptions(new File(a.path)));items[a.id].name=a.name||a.id;}
        for(var i=0;i<comps.length;i++){
            var c=comps[i],comp=c.existing_name?uniqueItem(c.existing_name):app.project.items.addComp(c.name||c.id,c.width,c.height,1,c.duration,c.fps||30);items[c.id]=comp;
            comp.motionBlur=c.motion_blur!==false;comp.shutterAngle=c.shutter_angle||180;
            if(c.background)comp.bgColor=c.background;
            var layers={},specs=c.layers||[];
            for(var j=0;j<specs.length;j++){
                var s=specs[j],l;
                if(s.existing_name){l=comp.layer(s.existing_name);if(!l)throw Error('Layer missing '+s.existing_name);}
                else if(s.type==='solid')l=comp.layers.addSolid(s.color||[0,0,0],s.name||s.id,s.width||comp.width,s.height||comp.height,1,comp.duration);
                else if(s.type==='text') {l=comp.layers.addText(s.text||'');var tp=l.property('ADBE Text Properties').property('ADBE Text Document'),td=tp.value;td.font=s.font||'ArialMT';td.fontSize=s.font_size||72;td.fillColor=s.color||[1,1,1];td.applyFill=true;td.justification=s.align==='left'?ParagraphJustification.LEFT_JUSTIFY:ParagraphJustification.CENTER_JUSTIFY;tp.setValue(td);if(s.center_anchor!==false){var r=l.sourceRectAtTime(0,false);l.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([r.left+r.width/2,r.top+r.height/2]);}}
                else if(s.type==='null')l=comp.layers.addNull(comp.duration);
                else if(s.type==='camera')l=comp.layers.addCamera(s.name||s.id,[comp.width/2,comp.height/2]);
                else if(s.type==='shape'){
                    l=comp.layers.addShape();var vectors=l.property('ADBE Root Vectors Group'),v=s.shape||{};
                    if(v.vertices){var sh=vectors.addProperty('ADBE Vector Shape - Group');sh.property('ADBE Vector Shape').setValue(shape(v));}
                    else {var sh=vectors.addProperty(v.ellipse?'ADBE Vector Shape - Ellipse':'ADBE Vector Shape - Rect');sh.property(v.ellipse?'ADBE Vector Ellipse Size':'ADBE Vector Rect Size').setValue(v.size||[100,100]);if(v.roundness!==undefined&&!v.ellipse)sh.property('ADBE Vector Rect Roundness').setValue(v.roundness);}
                    if(v.fill){var f=vectors.addProperty('ADBE Vector Graphic - Fill');f.property('ADBE Vector Fill Color').setValue(v.fill);}
                    if(v.stroke){var st=vectors.addProperty('ADBE Vector Graphic - Stroke');st.property('ADBE Vector Stroke Color').setValue(v.stroke);st.property('ADBE Vector Stroke Width').setValue(v.stroke_width||2);}
                } else l=comp.layers.add(items[s.source]);
                layers[s.id]=l;l.name=s.name||s.id;result.layer_count++;
                if(s.three_d)l.threeDLayer=true;
                if(s.type!=='camera')l.motionBlur=s.motion_blur!==false;
                if(s.start_time!==undefined)l.startTime=s.start_time;if(s.in_point!==undefined)l.inPoint=s.in_point;if(s.out_point!==undefined)l.outPoint=s.out_point;
                if(s.audio_enabled!==undefined&&l.hasAudio)l.audioEnabled=s.audio_enabled;
                if(s.blending_mode){if(BlendingMode[s.blending_mode]===undefined)throw Error('Unknown blending mode');l.blendingMode=BlendingMode[s.blending_mode];}
                if(s.time_remap){l.timeRemapEnabled=true;}
                for(var m=0;m<(s.masks||[]).length;m++){var ms=s.masks[m],mask=l.property('ADBE Mask Parade').addProperty('ADBE Mask Atom');mask.name=ms.name||'Mask';mask.property('ADBE Mask Shape').setValue(shape(ms));if(ms.feather)mask.property('ADBE Mask Feather').setValue(ms.feather);if(ms.mode)mask.maskMode=MaskMode[ms.mode];apply(mask,ms.properties);}
                for(var e=0;e<(s.effects||[]).length;e++){var ef=s.effects[e],group=l.property('ADBE Effect Parade');if(!group.canAddProperty(ef.matchName))throw Error('Effect unavailable '+ef.matchName);var effect=group.addProperty(ef.matchName);if(ef.name)effect.name=ef.name;apply(effect,ef.properties);}
                apply(l,s.properties);
            }
            for(var j=0;j<specs.length;j++)if(specs[j].parent)layers[specs[j].id].parent=layers[specs[j].parent];
        }
        var main=items[job.view_comp||(job.render&&job.render.comp)||comps[comps.length-1].id];main.openInViewer();main.time=job.view_time||0;
        if(job.render){
            if(job.render.multi_frame!==undefined){app.setMultiFrameRenderingConfig(job.render.multi_frame,job.render.max_cpu_percent||70);result.multi_frame=job.render.multi_frame;}
            if(job.render.purge_cache){app.purge(PurgeTarget.ALL_CACHES);result.cache_purged=true;}
            for(var q=1;q<=app.project.renderQueue.numItems;q++)if(app.project.renderQueue.item(q).status===RQItemStatus.QUEUED)app.project.renderQueue.item(q).render=false;
            var rq=app.project.renderQueue.items.add(items[job.render.comp]),om=rq.outputModule(1);
            if(job.render.start!==undefined)rq.timeSpanStart=job.render.start;
            if(job.render.duration!==undefined)rq.timeSpanDuration=job.render.duration;
            result.output_templates=om.templates;result.render_templates=rq.templates;
            if(job.render.render_template)rq.applyTemplate(job.render.render_template);
            if(job.render.output_template)om.applyTemplate(job.render.output_template);
            if(job.render.resolution_factor){applyRenderResolution(rq,items[job.render.comp],job.render.resolution_factor);om=rq.outputModule(1);}
            var movie=new File(output.fsName+'/render.'+(job.render.extension||'avi'));if(movie.exists)throw Error('Render exists');om.file=movie;
            result.output_settings=om.getSettings(GetSettingsFormat.STRING);
            app.project.save(projectFile);result.outputs.push(projectFile.fsName);
            app.endUndoGroup();undo=false;
            app.project.renderQueue.render();
            if(rq.status!==RQItemStatus.DONE)throw Error('Render did not complete');
            result.outputs.push(om.file.fsName);
            if(job.render.resolution_factor){
                var renderedFootage=app.project.importFile(new ImportOptions(om.file));
                try{result.actual_output_size=[renderedFootage.width,renderedFootage.height];}finally{renderedFootage.remove();}
                if(result.actual_output_size[0]!==result.expected_output_size[0]||result.actual_output_size[1]!==result.expected_output_size[1])throw Error('AE_OUTPUT_SIZE_MISMATCH: encoder output differs from requested size; keep this result and select a suitable output template');
            }
            result.status='rendered_pending_media_qa';
        }else{result.status='composed';result.outputs.push(projectFile.fsName);}
        app.project.save(projectFile);result.project=projectFile.fsName;
        main.openInViewer();main.time=job.view_time||0;
    } catch(error){result.status='failed';result.error=String(error);result.line=error.line;try{if(typeof targetReady!=='undefined'&&targetReady&&projectFile)app.project.save(projectFile);}catch(ignored){}}
    finally{if(undo)app.endUndoGroup();saveReceipt();}
})(YINZI_AE_JOB);