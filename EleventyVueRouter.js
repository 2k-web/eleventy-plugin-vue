const path = require("path");
const fastglob = require("fast-glob");
const lodashMerge = require("lodash.merge");
const rollup = require("rollup");
const rollupPluginVue = require("rollup-plugin-vue");
const rollupPluginCssOnly = require("rollup-plugin-css-only");
const { createRouter, createMemoryHistory } = require('vue-router');
const { createSSRApp } = require('vue');
const { renderToString } = require('@vue/server-renderer');
const { InlineCodeManager } = require("@11ty/eleventy-assets");

class EleventyVue {
  constructor(cacheDirectory) {
    this.workingDir = path.resolve(".");
    this.cacheDir = cacheDirectory;

    this.vueFileToCSSMap = {};
    this.vueFileToJavaScriptFilenameMap = {};
    this.routes = [];

    this.rollupBundleOptions = {
      format: "cjs", // because we’re consuming these in node. See also "esm"
      exports: "default",
      globals: { vue: 'Vue' },
      // dir: this.cacheDir
    };

    this.componentsWriteCount = 0;
  }

  reset() {
    this.vueFileToCSSMap = {};
  }
  
  resetFor(localVuePath) {
    this.vueFileToCSSMap[localVuePath] = [];
  }

  setCssManager(cssManager) {
    this.cssManager = cssManager;
  }

  setRollupPluginVueOptions(rollupPluginVueOptions) {
    this.rollupPluginVueOptions = rollupPluginVueOptions;
  }

  getRollupPluginVueOptions() {
    return lodashMerge({
      target: 'node'
      // Deprecated
      // css: false,
      // template: {
      //   optimizeSSR: true
      // }
      // compilerOptions: {} // https://github.com/vuejs/vue/tree/dev/packages/vue-template-compiler#options
    }, this.rollupPluginVueOptions);
  }

  setInputDir(inputDir) {
    this.inputDir = path.join(this.workingDir, inputDir);
  }
  
  setIncludesDir(includesDir) {
    this.includesDir = path.join(this.workingDir, includesDir);
  }

  setCacheDir(cacheDir) {
    this.cacheDir = cacheDir;
    this.rollupBundleOptions.dir = cacheDir;
  }

  isIncludeFile(filepath) {
    return filepath.startsWith(this.includesDir);
  }

  clearRequireCache(localVuePaths = []) {
    let fullCacheDir = path.join(this.workingDir, this.cacheDir);

    let deleteCount = 0;
    for(let fullPath in require.cache) {
      if(fullPath.startsWith(fullCacheDir)) {
        deleteCount++;
        // console.log( "Deleting from cache", fullPath );
        delete require.cache[fullPath];
      }
    }
    // console.log( `Deleted ${deleteCount} vue components from require.cache.` );
  }

  async findFiles(glob = "**/*.vue") {
    let globPath = path.join(this.inputDir, glob);
    return fastglob(globPath, {
      caseSensitiveMatch: false
    });
  }

  // Glob is optional
  async getBundle(input) {
    if(!input) {
      input = await this.findFiles();
    }

    let bundle = await rollup.rollup({
      input: input,
      external: ['vue'],
      plugins: [
        rollupPluginCssOnly({
          output: (styles, styleNodes) => {
            for(let fullVuePath in styleNodes) {
              this.addCSS(fullVuePath, styleNodes[fullVuePath]);
            }
          }
        }),
        rollupPluginVue(this.getRollupPluginVueOptions())
      ]
    });

    return bundle;
  }

  async write(bundle) {
    if(!bundle) {
      throw new Error("Eleventy Vue Plugin: write(bundle) needs a bundle argument.");
    }
    var { output } = await bundle.write(this.rollupBundleOptions);

    output = output.filter(entry => !!entry.facadeModuleId);

    return output;
  }

  async writeRoutesBundle(bundle, chunkNames=new Map, chunkImports=new Map) {
    var { output } = await bundle.write({
      ...this.rollupBundleOptions, 
      manualChunks: (id, chunkInfo) => {
        const match = /([^\/]*)\.vue$/.exec(id);

        if (!match) {
          const jsMatch = /(.*)\?vue&type=script&lang.js$/.exec(id);
          if (jsMatch) {
            chunkImports.set(jsMatch[1], chunkInfo.getModuleInfo(id).importedIds);
          }
          return null;
        }
        let chunkName = match[1];
        let ii = 0;
        while (chunkNames.has(chunkName)) {
          chunkName = `${match[1]}-${++ii}`;
        }
        chunkNames.set(chunkName, id);
        return chunkName;
      },
      chunkFileNames: (info) => {
        if (chunkNames.has(info.name)) {
          return "[name].js"
        }
        return "[name]-[hash].js"
      }
    });

    output = output.filter(entry => !!entry.facadeModuleId);

    return output;
  }

  createVueComponentsFromChunkInfo(map, chunkImports) {
    this.componentsWriteCount = 0;

    map.forEach((sourceFile, chunkName) => {
      this.createVueComponent(sourceFile, `${chunkName}.js`);
    });

    if (this.cssManager) {
      map.forEach((sourceFile) => {
        let isFullTemplateFile = !this.isIncludeFile(sourceFile);
        if (isFullTemplateFile && chunkImports.has(sourceFile)) {
          chunkImports.get(sourceFile).forEach((importFilename,k) => {
            this.cssManager.addComponentRelationship(
              this.getJavaScriptComponentFile(this.getLocalVueFilePath(sourceFile)), 
              this.getJavaScriptComponentFile(this.getLocalVueFilePath(importFilename))
            );
          })
        }
      });
    }    
  }

  createVueComponent(fullVuePath, jsFilename) {
    let inputPath = this.getLocalVueFilePath(fullVuePath);

    this.addVueToJavaScriptMapping(inputPath, jsFilename);

    let css = this.getCSSForComponent(inputPath);

    if(css && this.cssManager) {
      this.cssManager.addComponentCode(jsFilename, css);
    }

    this.componentsWriteCount++;
  }

  // output is returned from .write()
  createVueComponents(output) {
    this.componentsWriteCount = 0;
    for(let entry of output) {
      let fullVuePath = entry.facadeModuleId;

      let inputPath = this.getLocalVueFilePath(fullVuePath);
      let jsFilename = entry.fileName;

      this.addVueToJavaScriptMapping(inputPath, jsFilename);

      let css = this.getCSSForComponent(inputPath);
      if(css && this.cssManager) {
        this.cssManager.addComponentCode(jsFilename, css);
      }

      let isFullTemplateFile = !this.isIncludeFile(fullVuePath);
      if(isFullTemplateFile) {
        if(this.cssManager) {
          // If you import it, it will roll up the imported CSS in the CSS manager

          for(let importFilename of entry.imports) {
            this.cssManager.addComponentRelationship(jsFilename, importFilename);
          }
        }
      }
      this.componentsWriteCount++;
    }
  }

  getLocalVueFilePath(fullPath, extension=".vue") {
    let filePath = fullPath;
    if(fullPath.startsWith(this.workingDir)) {
      filePath = `.${fullPath.substr(this.workingDir.length)}`;
    }
    return filePath.substr(0, filePath.lastIndexOf(extension) + extension.length);
  }

  /* CSS */
  addCSS(fullVuePath, cssText) {
    let localVuePath = this.getLocalVueFilePath(fullVuePath);

    if(!this.vueFileToCSSMap[localVuePath]) {
      this.vueFileToCSSMap[localVuePath] = [];
    }
    this.vueFileToCSSMap[localVuePath].push(cssText.trim());
  }

  getCSSForComponent(localVuePath) {
    return (this.vueFileToCSSMap[localVuePath] || []).join("\n");
  }

  /* Map from vue files to compiled JavaScript files */
  addVueToJavaScriptMapping(localVuePath, jsFilename) {
    this.vueFileToJavaScriptFilenameMap[localVuePath] = jsFilename;
  }

  getJavaScriptComponentFile(localVuePath) {
    return this.vueFileToJavaScriptFilenameMap[localVuePath];
  }

  getFullJavaScriptComponentFilePath(localVuePath) {
    let jsFilename = this.getJavaScriptComponentFile(localVuePath);
    let fullComponentPath = path.join(this.workingDir, this.cacheDir, jsFilename);
    return fullComponentPath;
  }

  getComponent(localVuePath) {
    let fullComponentPath = this.getFullJavaScriptComponentFilePath(localVuePath);

    const result = require(fullComponentPath);

    //When the component is a chunk, it is under the 'script' export rather than the default export.

    return result.script || result;
  }

  async saveRoutesMapping(output) {
    const entry = output[0];
    let jsFilename = entry.fileName;
    let inputPath = path.join(this.workingDir, this.cacheDir, jsFilename);
    const resolveAsyncComponents = async item => {
      return {
        ...item,
        component: item.component.__asyncLoader ? (await item.component.__asyncLoader()).default : item.component,
        children: item.children ? await Promise.all(item.children.map(resolveAsyncComponents)) : []
      }
    }
    this.routes = await Promise.all(require(inputPath).map(resolveAsyncComponents));
  }

  async renderComponent(vueComponent, data, mixin = {}, wrapperComponent) {

    // We don’t use a local mixin for this because it’s global to all components
    // We don’t use a global mixin for this because modifies the Vue object and
    // leaks into other templates (reports wrong page.url!)
    
    // Full data cascade is available to the root template component
    // if(!vueComponent.mixins) {
    //   vueComponent.mixins = [];
    // }

    // This is how 11ty data was being previously made available to components. Currently trying global property instead, but we may want this back.

    // vueComponent.mixins.push({
    //   data: function() {
    //     return data;
    //   },
    // });

    const app = createSSRApp(wrapperComponent || vueComponent);
    const router = createRouter({ routes: this.routes, history: createMemoryHistory() });

    app.use(router);
    router.push(data.page.url)

    await router.isReady();

    app.config.globalProperties.$11ty = data;

    app.mixin(mixin);

    if(!("page" in app.config.globalProperties)) {
      Object.defineProperty(app.config.globalProperties, "page", {
        get () {
          // https://vuejs.org/v2/api/#vm-root
          return this.$root.$options.data().page;
        }
      })
    }

    const html = await renderToString(app);

    return html;
  }
}

module.exports = EleventyVue;