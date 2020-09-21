const path = require("path");
const lodashMerge = require("lodash.merge");

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

  let componentCount = 0;
  let changedFilesOnWatch = [];

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
    console.log( `---
Built ${count} component${count !== 1 ? "s" : ""} (eleventy-plugin-vue v${pkg.version})` );
  });

  // `beforeWatch` is available on Eleventy 0.11.0 (beta.3) and newer
  eleventyConfig.on("beforeWatch", (changedFiles) => {
    // `changedFiles` array argument is available on Eleventy 1.0+
    changedFilesOnWatch = (changedFiles || []).filter(file => file.endsWith(".vue"));

    // Only reset what changed! (Partial builds for Vue rollup files)
    if(changedFilesOnWatch.length) {
      for(let localVuePath of changedFilesOnWatch) {
        let jsFilename = eleventyVue.getJavaScriptComponentFile(localVuePath);
        cssManager.resetComponentCodeFor(jsFilename);

        eleventyVue.resetFor(localVuePath);
      }
    } else {
      cssManager.resetComponentCode();
      eleventyVue.reset();
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
      eleventyVue.clearRequireCache(changedFilesOnWatch);

      let files = changedFilesOnWatch;
      if(!files || !files.length) {
        files = await eleventyVue.findFiles();
      }
      let bundle = await eleventyVue.getBundle(files);
      let output = await eleventyVue.write(bundle);

      eleventyVue.createVueComponents(output);
    },
    compile: function(str, inputPath) {
      return async (data) => {
        let vueComponent = eleventyVue.getComponent(data.page.inputPath);

        let componentName = eleventyVue.getJavaScriptComponentFile(data.page.inputPath);
        cssManager.addComponentForUrl(componentName, data.page.url);

        let vueMixin = {
          methods: this.config.javascriptFunctions,
        };

        return eleventyVue.renderComponent(vueComponent, data, vueMixin);
      };
    }
  });
};

module.exports.EleventyVue = EleventyVue;