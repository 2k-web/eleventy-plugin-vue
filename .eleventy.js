const path = require("path");
const lodashMerge = require("lodash.merge");
const { createRouter, createMemoryHistory } = require('vue-router');
const { InlineCodeManager } = require("@11ty/eleventy-assets");

const EleventyVue = require("./EleventyVue");
const pkg = require("./package.json");

const globalOptions = {
  cacheDirectory: ".cache/vue/",
  // See https://rollup-plugin-vue.vuejs.org/options.html
  rollupPluginVueOptions: {},
  assets: {
    css: null
  } // optional `eleventy-assets` instances
};

module.exports = function(eleventyConfig, configGlobalOptions = {}) {
  let options = lodashMerge({}, globalOptions, configGlobalOptions);

  let eleventyVue = new EleventyVue();
  eleventyVue.setCacheDir(options.cacheDirectory);

  let cssManager = options.assets.css || new InlineCodeManager();
  eleventyVue.setCssManager(cssManager);

  let changedFilesOnWatch = [];
  let skipVueBuild = false;

  // Only add this filter if you’re not re-using your own asset manager.
  // TODO Add warnings to readme
  // * This will probably only work in a layout template.
  // * Probably complications with components that are only used in a layout template.
  eleventyConfig.addFilter("getVueComponentCssForPage", (url) => {
    return cssManager.getCodeForUrl(url);
  });

  // TODO check if verbose mode for console.log
  eleventyConfig.on("afterBuild", () => {
    let count = eleventyVue.componentsWriteCount;
    if(count > 0) {
      console.log( `Built ${count} component${count !== 1 ? "s" : ""} (eleventy-plugin-vue v${pkg.version})` );
    }
  });

  // `beforeWatch` is available on Eleventy 0.11.0 and newer
  eleventyConfig.on("beforeWatch", (changedFiles) => {
    // `changedFiles` array argument is available on Eleventy 0.11.1+
    changedFilesOnWatch = (changedFiles || []).filter(file => file.endsWith(".vue"));

    // Only reset what changed! (Partial builds for Vue rollup files)
    if(changedFilesOnWatch.length > 0) {
      skipVueBuild = false;
      for(let localVuePath of changedFilesOnWatch) {
        let jsFilename = eleventyVue.getJavaScriptComponentFile(localVuePath);
        cssManager.resetComponentCodeFor(jsFilename);

        eleventyVue.resetFor(localVuePath);
      }
    } else {
      if(changedFiles && changedFiles.length > 0) {
        skipVueBuild = true;
      }
      // TODO reset all if incremental not enabled
      // cssManager.resetComponentCode();
      // eleventyVue.reset();
    }
  });

  eleventyConfig.addTemplateFormats("vue");

  eleventyConfig.addExtension("vue", {
    read: false, // We use rollup to read the files
    getData: true,
    getInstanceFromInputPath: function(inputPath) {
      return eleventyVue.getComponent(inputPath);
    },
    init: async function() {
      eleventyVue.setInputDir(this.config.inputDir);
      eleventyVue.setIncludesDir(path.join(this.config.inputDir, this.config.dir.includes));
      eleventyVue.setRollupPluginVueOptions(options.rollupPluginVueOptions);

      if(skipVueBuild) {
        // for write count
        eleventyVue.createVueComponents([]);
      } else {
        eleventyVue.clearRequireCache(changedFilesOnWatch);

        if (!options.routesPath) {
          let files = changedFilesOnWatch;
          if(!files || !files.length) {
            files = await eleventyVue.findFiles();
          }
          var bundle = await eleventyVue.getBundle(files);

          var output = await eleventyVue.write(bundle);
    
          eleventyVue.createVueComponents(output);
        } else {
          routesBundle = await eleventyVue.getBundle(options.routesPath);
          let chunkNames = new Map;
          output = await eleventyVue.writeRoutesBundle(routesBundle, chunkNames);

          eleventyVue.createVueComponentsFromMap(chunkNames);
          eleventyVue.saveRoutesMapping(output);

          //write app component
          let appBundle = await eleventyVue.getBundle(options.appPath);
          output = await eleventyVue.write(appBundle);
          eleventyVue.createVueComponents(output);
        }        
      }
    },
    compile: function(str, inputPath) {
      // TODO this runs twice per template
      return async (data) => {
        // since `read: false` is set 11ty doesn't read file contents
        // so if str has a value, it's a permalink (which can be a string or a function)
        // currently Vue template syntax in permalink string is not supported.
        const processVueRoute = (routeObj) => {
          let vueComponent = eleventyVue.getComponent(data.page.inputPath);
          const route = eleventyVue.routes.find(route => route.component === vueComponent);
          if (!route.name) {
            throw new Error(`Routes must have a name`);
          }
          const router = createRouter({ routes: eleventyVue.routes, history: createMemoryHistory() });
          const resolvedRoute = router.resolve({ ...routeObj, params: { ...routeObj.params }, name: route.name });

          return resolvedRoute.href.replace(/\/?$/, '/index.html');
        }

        if (str) {
          if(typeof str === "function") {
            str = await str(data);
          }
          
          if (typeof str === 'object') {
            //vue route object
            return processVueRoute(str);
          }

          return str;
        }
        
        let vueComponent = eleventyVue.getComponent(data.page.inputPath);
        let appComponent = eleventyVue.getComponent(options.appPath);

        let componentName = eleventyVue.getJavaScriptComponentFile(data.page.inputPath);
        cssManager.addComponentForUrl(componentName, data.page.url);

        let vueMixin = {
          methods: this.config.javascriptFunctions,
        };

        return eleventyVue.renderComponent(vueComponent, data, vueMixin, appComponent);
      };
    }
  });
};

module.exports.EleventyVue = EleventyVue;
