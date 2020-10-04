import {DataBlock, DataRef} from '../core/lib_api.js';
import {loadShader, Shaders} from '../shaders/shaders.js';
import {LightGen, getBlueMaskDef, setBlueUniforms, getBlueMask} from '../shadernodes/shader_lib.js';
import {FBO} from '../core/fbo.js';

import {Vector2, Vector3, Vector4, Quat, Matrix4} from '../util/vectormath.js';
import * as util from '../util/util.js';
import '../path.ux/scripts/util/struct.js';
let STRUCT = nstructjs.STRUCT;
import {SceneObject, ObjectFlags} from '../sceneobject/sceneobject.js';
import {RenderEngine} from "./renderengine_base.js";
import {Mesh} from '../mesh/mesh.js';
import {FBOSocket, RenderContext, RenderGraph, RenderPass} from "./renderpass.js";
import {Node, Graph, NodeSocketType, NodeFlags, SocketFlags, SocketTypes} from "../core/graph.js";
import {FloatSocket} from "../core/graphsockets.js";

let zero = new Vector2([0, 0]);

let makeBlue = (totpoint) => {
  let dimen = Math.sqrt(totpoint);
  dimen = Math.ceil(Math.max(dimen, 2.0));

  let PX=0, PY=1, PTOT=2;

  let r = 1.0 / dimen;
  let rsqr = r*r;

  let ps = new Float64Array(PTOT*totpoint);

  for (let pi=0; pi<ps.length; pi += PTOT) {
    let x = Math.random(), y = Math.random();

    let th = x*Math.PI*2.0;
    let r = y;

    x = Math.cos(th)*r;
    y = Math.sin(th)*r;

    ps[pi+PX] = x;
    ps[pi+PY] = y;
  }

  function getr(x, y) {
    let d = Math.sqrt(x*x + y*y);

    d = d*d*(3.0 - 2.0*d);

    return r + d*r*3;
  }

  let do_step = () => {
    //return;
    for (let pi1=0; pi1<ps.length; pi1 += PTOT) {
      let x1 = ps[pi1+PX], y1 = ps[pi1+PY];
      let sumx=0, sumy=0, tot=0;

      let d = 2.0 - Math.sqrt((x1-0.5)**2 + (y1-0.5)**2) / Math.sqrt(2.0);
      let r1 = getr(x1, y1);

      ps[pi1+PX] -= x1*0.005;
      ps[pi1+PY] -= y1*0.005;

      for (let pi2 = 0; pi2 < ps.length; pi2 += PTOT) {
        let x2 = ps[pi2 + PX], y2 = ps[pi2 + PY];

        if (pi1 === pi2) {
          continue;
        }

        let r2 = getr(x2, y2);

        let rtest = (r1 + r2)*0.5;

        if (isNaN(rtest)) {
          //throw new Error();
        }

        if (rtest == 0.0 || isNaN(rtest)) {
          continue;
        }

        let dx = x1 - x2;
        let dy = y1 - y2;

        let dis = dx * dx + dy * dy;

        if (dis > rtest*rtest) {
          continue;
        }

        dis = Math.sqrt(dis);
        let w = 1.0 - dis / rtest;
        //w = Math.pow(w, 500.0)
        w = w*w*(3.0 - 2.0*w);
        w *= w;

        sumx += dx * w;
        sumy += dy * w;
        tot += w;
      }

      if (!tot) {
        continue;
      }

      sumx /= tot;
      sumy /= tot;

      ps[pi1+PX] += sumx*0.14;
      ps[pi1+PY] += sumy*0.14;
    }
  }

  for (let step=0; step<40; step++) {
    do_step()
  }

  let len = 0.0;
  for (let pi=0; pi<ps.length; pi += PTOT) {
    let x = ps[pi+PX], y = ps[pi+PY];
    let d = x*x + y*y;

    len = Math.max(len, d);
  }
  len = Math.sqrt(len);

  let ret = [];
  for (let pi=0; pi<ps.length; pi += PTOT) {
    let x = ps[pi+PX]/len;
    let y = ps[pi+PY]/len;
    let w = Math.sqrt(x*x + y*y);

    ret.push([x, y, w]);
  }

  return ret;
}
window.makeBlue = makeBlue;

let jcache = {};
let getJitterSamples = (totpoint) => {
  if (totpoint in jcache) {
    return jcache[totpoint];
  }

  console.log("making new jitter sample set of size " + totpoint);

  if (totpoint < 2) {
    jcache[totpoint] = [0, 0, 1];
  } else {
    jcache[totpoint] = makeBlue(totpoint);
  }

  return jcache[totpoint];
}
window.getJitterSamples = getJitterSamples;


export class BasePass extends RenderPass {
  constructor() {
    super();
  }

  static nodedef() {return {
    uiname : "Base Pass",
    name   : "base_pass",
    inputs : Node.inherit({
      ao      : new FBOSocket(),
      normal  : new FBOSocket()
    }),
    outputs : Node.inherit({
      w : new FloatSocket()
    }),
    shader : ``
  }}

  renderIntern(rctx) {
    let gl = rctx.gl;

    //gl.clearColor = () => {};
    //gl.clear = () => {};

    gl.clearColor(1.0, 1.0, 1.0, 1.0);
    gl.clearDepth(1.0);
    gl.depthMask(true);

    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    let jit = getJitterSamples(55);
    let shift = jit[rctx.uSample % jit.length];
    let scale = 2.0 / Math.sqrt(jit.length);

    let r = 2.0;

    let shiftx = (shift[0]+(Math.random()-0.5)*scale)*r;
    let shifty = (shift[1]+(Math.random()-0.5)*scale)*r;
    let projectionMatrix = rctx.engine.render_intern(rctx.drawmats, rctx.gl, zero, rctx.size, rctx.scene, shiftx, shifty);

    let w = shift[2];

    /*
    //apply some sharpening in the pixel accumulation filter

    //sinc function
    w = 1.0 - Math.min(Math.sin(w*Math.PI) / (w*Math.PI), 1.0);
    //w = w*w*(3.0 - 2.0*w);
    //make sure it dips below zero
    w -= 0.2
    */

    this.outputs.w.setValue(w);

    if (rctx.engine.extraDrawCB) {
      rctx.engine.extraDrawCB(new Matrix4(projectionMatrix));
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
    }
  }
}


export class NormalPass extends RenderPass {
  constructor() {
    super();
  }

  static nodedef() {return {
    uiname : "Normal Pass",
    name   : "normal_pass",
    inputs : Node.inherit({

    }),
    outputs : Node.inherit({

    }),
    shaderPre : ``,
    shader : ``
  }}

  renderIntern(rctx) {
    let gl = rctx.gl;

    //console.log("normal pass exec!");

    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clearDepth(1.0);
    gl.depthMask(true);

    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    rctx.engine.render_normals(rctx.drawmats, rctx.gl, zero, rctx.size, rctx.scene);
  }
}

export class OutputPass extends RenderPass {
  constructor() {
    super();
  }

  static nodedef() {return {
    uiname : "Output Pass",
    name   : "output_pass",
    inputs : Node.inherit({
    }),
    outputs : Node.inherit({

    }),

    shaderPre : `
    uniform float weightSum;
    
    float hashrand(vec2 uv) {
      float f = fract(uSample*sqrt(3.0) + uv[0]*sqrt(3.0) + uv[1]*sqrt(5.0));
      
      return fract(1.0 / (f*0.00001 + 0.000001));
    }
    `,

    shader : `
    vec4 color = texture2D(fbo_rgba, v_Uv);
    color.rgb = color.rgb / weightSum;
    color.a = 1.0;
    
    //dither
#if 0
    float sc = max(2.0, 20.0 - uSample);
    float f = (hashrand(v_Uv)-0.5)*sc/255.0;
    float f2 = (hashrand(v_Uv+vec2(0.234, 0.523))-0.5)*sc/255.0;
    float f3 = (hashrand(v_Uv+vec2(0.313, -0.323))-0.5)*sc/255.0;
    color[0] += f;
    color[1] += f2;
    color[2] += f3;
    
    for (int i=0; i<3; i++) {
      //color[i] = floor(color[i]*255.0)/255.0;
    }
#endif
gl_FragColor = color;
gl_FragDepth = sampleDepth(fbo_depth, v_Uv);
    `
  }}

  renderIntern(rctx) {
    let gl = rctx.gl;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    gl.depthMask(true);

    this.uniforms.weightSum = rctx.weightSum;

    super.renderIntern(rctx);

    //run 'chrome --enable-privileged-webgl-extension' from shell
    //let fragmentShader = this._shader.fragmentShader;
    //console.log(gl.getExtension("WEBGL_debug_shaders").getTranslatedShaderSource(fragmentShader));

  }
}

export class AOPass extends RenderPass {
  constructor() {
    super();
  }

  static nodedef() {return {
    uiname : "AO Pass",
    name   : "ao_pass",
    inputs : Node.inherit({}),
    outputs : Node.inherit({}),
    shaderPre : `
    
    ${getBlueMaskDef().shaderPre}
    
uniform float dist;
uniform float factor;
uniform float steps;

//const float dist=2.0, factor=2.5, steps=1024.0;

#define samples 2
#define seed1 0.23432
#define seed2=1.2342


vec4 unproject(vec4 p) {
  vec4 p2 = iprojectionMatrix * vec4(p.xyz, 1.0);
  
  p2.xyz /= p2.w;
  
  return p2;
}

#if 0
float sample_blue(vec2 uv) {
  float x = fract(uv[0] * size[0] / bluemask_size[0]); 
  float y = fract(uv[1] * size[1] / bluemask_size[1]); 
  
  return texture2D(bluemask, vec2(x, y))[0];
}
#endif

float rand(float x, float y, float seed) {
  //partially de-correlate with blue noise mask
  float sf = sampleBlue(vec2(x, y))[0];

  
  //squish blue noise range
  sf = floor(sf*14.0)/14.0;
  
  //add uSample
  sf += fract(uSample*sqrt(3.0))*0.1;
  
  //sf = 0.0;
  //sf = fract(x*sqrt(3.0) + y*sqrt(5.0) + uSample*0.25*sqrt(3.0));
  //sf = fract(1.0 / (sf*0.001 + 0.000001));
  
  seed += sf*10.0; 
  
  float f = fract(seed*sqrt(3.0));

  f = fract(1.0 / (f*0.00001 + 0.00001));
  
  return f;
}

    `,
    shader : `
  vec4 p = vec4(gl_FragCoord.xyz, 1.0);
  p.xy = (p.xy / size)*2.0 - 1.0;

  p.z = sampleDepth(fbo_depth, v_Uv);
  float z = p.z;

  p = unproject(p);
  
  float seed = 0.0;
  
  float f = 0.0;
  float tot = 0.0;
  vec3 nin = texture2D(fbo_rgba, v_Uv).rgb*2.0 - 1.0; 
  
  for (int i=0; i<samples; i++) {
    vec3 n;
    n[0] = rand(v_Uv[0], v_Uv[1], seed)-0.5;
    n[1] = rand(v_Uv[0], v_Uv[1], seed+1.0)-0.5;
    n[2] = rand(v_Uv[0], v_Uv[1], seed+2.0)-0.5;
    
    //n = normalize(n + 0.25*nin);
    
    if (dot(n, nin) < 0.0) {
      n = -n;
    }
    
    n *= dist;
    vec4 p2 = vec4(p.xyz, 1.0) + vec4(n, 0.0);
    p2 = projectionMatrix * p2;
    
    p2.xyz /= p2.w;
    float oldz = p2.z;
    
    vec4 c = texture2D(fbo_rgba, (p2.xy*0.5 + 0.5));
    p2.z = sampleDepth(fbo_depth, (p2.xy*0.5 + 0.5));
    
    vec4 p3 = unproject(p2);
    //float w = min(length(p3.xyz - p.xyz) / dist, 1.0);
    float w = length(p3.xyz - p.xyz) / dist;
    
    w = w > 2.0 ? 0.0 : min(w, 1.0);
    
    if (c[3]<0.2 || p2.z + (1.0+0.00025*seed1)*abs(oldz-p2.z) > oldz) {
      w = 0.0;
    }
    
    f += w;
    
    seed += sqrt(5.0);
    tot += 1.0;
  }

  f = tot == 0.0 ? 1.0 : f / tot;
  f = min(f, 1.0);
  
  f = pow(1.0 - f, factor);

  //f = rand(v_Uv[0], v_Uv[1], 0.0);
  f = clamp(f, 0.0, 1.0);
  f = isnan(f) ? 1.0 : f;
   
  vec4 color = texture2D(fbo_rgba, v_Uv);
  gl_FragColor = vec4(f, f, f, 1.0);
  
  //gl_FragColor = texture2D(fbo_rgba, v_Uv);
  //gl_FragColor = vec4(texture2D(fbo_rgba, v_Uv).rgb, 1.0);
  
  gl_FragDepth = sampleDepth(fbo_depth, v_Uv);
  
`
  }}

  renderIntern(rctx) {
    let gl = rctx.gl;

    setBlueUniforms(this.uniforms, rctx.size, getBlueMask(gl), rctx.uSample);

    this.uniforms.factor = rctx.scene.envlight.ao_fac;
    this.uniforms.dist = rctx.scene.envlight.ao_dist;
    this.uniforms.steps = 10240;

    super.renderIntern(rctx, false);
  }
}

export class BlurPass extends RenderPass {
  constructor() {
    super();
  }

  getDebugName() {
    if (this.inputs.axis.getValue() === 1) {
      return "blur_y";
    } else {
      return "blur_x";
    }
  }

  static nodedef() {return {
    uiname : "Blur Pass",
    name   : "blur_pass",

    inputs : Node.inherit({
      axis    : new FloatSocket(undefined, undefined, 0),
      samples : new FloatSocket(undefined, undefined, 3)
    }),

    outputs : Node.inherit({

    }),

    shaderPre : `
       
    `,
    shader2: `
      gl_FragColor = vec4(1.0, 0.75, 0.45, 1.0); //texture2D(fbo_rgba, v_Uv);
      gl_FragDepth = sampleDepth(fbo_depth, v_Uv);
    `,
    shader : `
    
    vec4 accum;
    float tot=0.0;
    vec2 p = v_Uv * size;
    const float isamp = 1.0 / float(BLUR_SAMPLES);
      
    for (int i=-BLUR_SAMPLES; i<BLUR_SAMPLES; i++) {
      float w = 1.0 - abs(float(i) / float(BLUR_SAMPLES));
      //w = w*(1.0 - isamp) + isamp;
      
      //w = w*w*(3.0 - 2.0*w);
      //w = 1.0;
      vec2 p2 = p;
      
      p2[BLUR_AXIS] += float(i);
      
      vec4 color = texture2D(fbo_rgba, p2 / size);
      
      accum += color*w;
      tot += w;
    }
    
    accum /= tot;
    
    //gl_FragColor = vec4(1.0, 0.75, 0.45, 1.0);
    gl_FragColor = accum;
    gl_FragDepth = sampleDepth(fbo_depth, v_Uv);
    `,
  }}

  renderIntern(rctx) {
    let shaderPre = this.constructor.nodedef().shaderPre;

    shaderPre += "#define BLUR_SAMPLES " + (~~this.inputs.samples.getValue()) + "\n";

    if (this.inputs.axis.getValue() === 0.0) {
      shaderPre = "#define BLUR_AXIS 0\n" + shaderPre;
    } else {
      shaderPre = "#define BLUR_AXIS 1\n" + shaderPre;
    }

    this.shaderPre = shaderPre;
    super.renderIntern(rctx);
  }
}

export class DenoiseBlur extends RenderPass {
  constructor() {
    super();
  }

  getDebugName() {
    if (this.inputs.axis.getValue() === 1) {
      return "blur_y";
    } else {
      return "blur_x";
    }
  }

  static nodedef() {return {
    uiname : "Denoise Blur",
    name   : "denoise_blur",

    //expects .fbo input to have the depth in the alpha component
    inputs : Node.inherit({
      axis    : new FloatSocket(undefined, undefined, 0),
      samples : new FloatSocket(undefined, undefined, 3),
      depthScale : new FloatSocket(undefined, undefined, 10.0),
      depthOffset : new FloatSocket(undefined, undefined, -0.9)

    }),

    outputs : Node.inherit({

    }),

    shaderPre : ``,
       
    shader : `
    
    vec4 accum;
    float tot=0.0;
    vec2 p = v_Uv * size;
    const float isamp = 1.0 / float(BLUR_SAMPLES);
 
    vec4 samp = texture2D(fbo_rgba, v_Uv);
    float d = samp[2];
    float persw = samp[3];
    
    //XXX scale depth range properly
    
    d = (d + DEPTH_OFFSET)*DEPTH_SCALE;
    
    for (int i=-BLUR_SAMPLES; i<BLUR_SAMPLES; i++) {
      float w = 1.0 - abs(float(i) / float(BLUR_SAMPLES));
      //w = w*(1.0 - isamp) + isamp;
      
      //w = w*w*(3.0 - 2.0*w);
      //w = 1.0;
      vec2 p2 = p;
      
      p2[BLUR_AXIS] += float(i);//persw;
      
      vec4 color = texture2D(fbo_rgba, p2 / size);
      float d2 = color[2];
      d2 = (d2 + DEPTH_OFFSET)*DEPTH_SCALE;
      
      color[0] *= d2 < 0.00001 ? 0.0001 : d2;
      
      accum += color*w;
      tot += w;
    }
    
    accum /= tot;
    accum /= d == 0.0 ? 0.0001 : d;
    
    //gl_FragColor = vec4(1.0, 0.75, 0.45, 1.0);
    //accum = vec4(d, d, d, 1.0);
#if BLUR_AXIS == 0
    gl_FragColor = vec4(accum[0], accum[0], d, persw);
#else
    gl_FragColor = vec4(accum[0], accum[0], accum[0], 1.0);
#endif
    gl_FragDepth = sampleDepth(fbo_depth, v_Uv);
    `,
  }}

  renderIntern(rctx) {
    let shaderPre = this.constructor.nodedef().shaderPre;

    shaderPre += "#define BLUR_SAMPLES " + (~~this.inputs.samples.getValue()) + "\n";

    let scale = this.inputs.depthScale.getValue().toString();
    if (scale.search(/\./) < 0) {
      scale += ".0";
    }

    shaderPre += "#define DEPTH_SCALE " + scale + "\n";

    let off = this.inputs.depthOffset.getValue().toString();
    if (off.search(/\./) < 0) {
      off += ".0";
    }
    shaderPre += "#define DEPTH_OFFSET " + off + "\n";

    if (this.inputs.axis.getValue() === 0.0) {
      shaderPre = "#define BLUR_AXIS 0\n" + shaderPre;
    } else {
      shaderPre = "#define BLUR_AXIS 1\n" + shaderPre;
    }

    this.shaderPre = shaderPre;
    super.renderIntern(rctx);
  }
}

export class SharpenPass extends RenderPass {
  constructor() {
    super();
  }

  static nodedef() {return {
    uiname : "Sharpen Pass",
    name   : "sharpen",

    inputs : Node.inherit({
      axis    : new FloatSocket(),
      samples : new FloatSocket(undefined, undefined, 1),
      factor  : new FloatSocket("factor", undefined, 0.5)
    }),

    outputs : Node.inherit({

    }),

    shaderPre : `
    uniform float sharpen;
    `,
    uniforms : {'sharpen' : 0.5},
    shader : `
    
    vec4 accum;
    float tot=0.0;
    vec2 p = v_Uv * size;
    const float isamp = 1.0 / float(SAMPLES);
      
    for (int i=-SAMPLES; i<SAMPLES; i++) {
      float w = 1.0 - abs(float(i) / float(SAMPLES));
      //w = w*(1.0 - isamp) + isamp;
      
      w = w*w*(3.0 - 2.0*w);
      w -= 0.4;
      vec2 p2 = p;
      
      p2[AXIS] += float(i);
      
      vec4 color = texture2D(fbo_rgba, p2 / size);
      
      accum += color*w;
      tot += w;
    }
    
    accum /= tot;
    
    gl_FragColor = accum + (texture2D(fbo_rgba, v_Uv) - accum)*(1.0 - sharpen);
    gl_FragDepth = sampleDepth(fbo_depth, v_Uv);
    `,
  }}

  renderIntern(rctx) {
    let shaderPre = this.constructor.nodedef().shaderPre;

    shaderPre += "#define SAMPLES " + (~~this.inputs.samples.getValue()) + "\n";

    if (this.inputs.axis.getValue() === 0.0) {
      shaderPre = "#define AXIS 0\n" + shaderPre;
    } else {
      shaderPre = "#define AXIS 1\n" + shaderPre;
    }

    this.uniforms.sharpen = this.inputs.factor.getValue();

    this.shaderPre = shaderPre;
    super.renderIntern(rctx, false);
  }
}

export class AccumPass extends RenderPass {
  constructor() {
    super();
  }

  static nodedef() {return {
    uiname : "Accum Pass",
    name   : "accum_pass",
    inputs : Node.inherit({
      w : new FloatSocket()
    }),
    outputs : Node.inherit({
    }),
    shaderPre : `
    
    ${getBlueMaskDef().shaderPre}
    
    uniform sampler2D lastBuf;
    uniform float weight;
    uniform float weightSum;
    `,
    shader : `
    
vec4 color1 = texture2D(fbo_rgba, v_Uv);
vec4 color2 = texture2D(lastBuf, v_Uv);

if (isnan(dot(color1, color1))) {
  gl_FragColor = vec4(color2.rgb, 1.0)*((weightSum+weight)/weightSum);
} else {
  gl_FragColor = vec4(color1.rgb, 1.0)*weight + vec4(color2.rgb, 1.0)*float(uSample > 1.0);
}
gl_FragDepth = sampleDepth(fbo_depth, v_Uv);
    `
  }}

  renderIntern(rctx) {
    let gl = rctx.gl;

    rctx.engine.weightSum += this.inputs.w.getValue();
    rctx.engine.weightSum  = Math.max(rctx.engine.weightSum, 0.0001);
    rctx.weightSum = rctx.engine.weightSum;

    this.uniforms.weight = this.inputs.w.getValue();

    setBlueUniforms(this.uniforms, rctx.size, getBlueMask(gl), rctx.uSample);

    //*
    let buf = rctx.engine.passThru.outputs.fbo.getValue();

    gl.clearDepth(1.0);
    gl.clear(gl.DEPTH_BUFFER_BIT);


    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);

    gl.disable(gl.BLEND);

    if (buf.texColor) {
      this.uniforms.weightSum = rctx.weightSum;
      this.uniforms.lastBuf = buf.texColor;

    }
    //*/

    super.renderIntern(rctx, false);
  }
}

export class PassThruPass extends RenderPass {
  constructor() {
    super();
  }

  static nodedef() {return {
    uiname : "Pass Thru Pass",
    name   : "passthru_pass",
    inputs : Node.inherit({
    }),
    outputs : Node.inherit({
    }),
    shader : `
gl_FragColor = texture2D(fbo_rgba, v_Uv);
gl_FragDepth = sampleDepth(fbo_depth, v_Uv);
    `
  }}

  renderIntern(rctx) {
    let gl = rctx.gl;

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);

    super.renderIntern(rctx, false);
  }
}
