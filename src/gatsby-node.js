import path from 'path';
import fs from 'fs';
import { mapValues, isPlainObject, trim } from 'lodash';
import webpack from 'webpack';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import HtmlWebpackExcludeAssetsPlugin from 'html-webpack-exclude-assets-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
// TODO: swap back when https://github.com/geowarin/friendly-errors-webpack-plugin/pull/86 lands
import FriendlyErrorsPlugin from 'friendly-errors-webpack-plugin';

// Deep mapping function for plain objects and arrays. Allows any value,
// including an object or array, to be transformed.
function deepMap(obj, fn) {
  // If the transform function transforms the value, regardless of type, return
  // the transformed value.
  const mapped = fn(obj);
  if (mapped !== obj) {
    return mapped;
  }

  // Recursively deep map arrays and plain objects, otherwise return the value.
  if (Array.isArray(obj)) {
    return obj.map(value => deepMap(value, fn));
  }
  if (isPlainObject(obj)) {
    return mapValues(obj, value => deepMap(value, fn));
  }
  return obj;
}

function replaceRule(value) {
  // If `value` does not have a `test` property, it isn't a rule object.
  if (!value || !value.test) {
    return value;
  }

  // remove dependency rule
  if (
    value.type === `javascript/auto` &&
    value.use &&
    value.use[0] &&
    value.use[0].options &&
    value.use[0].options.presets &&
    /babel-preset-gatsby[/\\]dependencies\.js/.test(
      value.use[0].options.presets,
    )
  ) {
    return null;
  }

  // Manually swap `style-loader` for `MiniCssExtractPlugin.loader`.
  // `style-loader` is only used in development, and doesn't allow us to pass
  // the `styles` entry css path to Netlify CMS.
  if (
    typeof value.loader === `string` &&
    value.loader.includes(`style-loader`)
  ) {
    return {
      ...value,
      loader: MiniCssExtractPlugin.loader,
    };
  }

  return value;
}

exports.onPreInit = ({ reporter }) => {
  try {
    require.resolve(`netlify-cms`);
    reporter.warn(
      `The netlify-cms package is deprecated for Gatsby, please install netlify-cms-app and remove netlify-cms. You can do this by running "yarn remove netlify-cms", "yarn add netlify-cms-app"`,
    );
  } catch (err) {
    // carry on
  }
};

exports.onCreateDevServer = ({ app, store }, { publicPath = `admin` }) => {
  const { program } = store.getState();
  const publicPathClean = trim(publicPath, `/`);
  app.get(`/${publicPathClean}`, function(req, res) {
    res.sendFile(
      path.join(program.directory, `public`, publicPathClean, `index.html`),
      err => {
        if (err) {
          res.status(500).end(err.message);
        }
      },
    );
  });
};

exports.onCreateWebpackConfig = (
  { store, stage, getConfig, plugins, pathPrefix, loaders, reporter },
  {
    modulePath,
    publicPath = `admin`,
    enableIdentityWidget = true,
    htmlTitle = `Content Manager`,
    htmlFavicon = ``,
    manualInit = false,
    buildCMS = true,
  },
) => {
  const developing = stage === `develop`;
  if (!buildCMS || ![`develop`, `build-javascript`].includes(stage)) {
    return Promise.resolve();
  }
  const gatsbyConfig = getConfig();
  const { program } = store.getState();
  const publicPathClean = trim(publicPath, `/`);
  const outputPath = path.join(program.directory, `public`, publicPathClean);
  // We don't want to build the cms app if we are publishing manually so,
  // check for production and the build is already inside static dir.
  // Push the static build of the cms to the repository to skip deploy building.
  // Although this will save build times, it requires a manual build and push.
  const staticBuildPath = path.join(
    program.directory,
    `static/${publicPathClean}`,
    `./cms.js`,
  );
  if (!developing && fs.existsSync(staticBuildPath)) {
    reporter.warn(
      `The cms already exists, so skipping build
      ${staticBuildPath}`,
    );
    return Promise.resolve();
  }
  const config = {
    ...gatsbyConfig,
    entry: {
      cms: [
        manualInit && `${__dirname}/cms-manual-init.js`,
        `${__dirname}/cms.js`,
        enableIdentityWidget && `${__dirname}/cms-identity.js`,
      ]
        .concat(modulePath)
        .filter(p => p),
    },
    output: {
      path: `${outputPath}`,
    },
    module: {
      rules: deepMap(gatsbyConfig.module.rules, replaceRule).filter(Boolean),
    },
    plugins: [
      // Remove plugins that either attempt to process the core Netlify CMS
      // application, or that we want to replace with our own instance.
      ...gatsbyConfig.plugins.filter(
        plugin =>
          ![`MiniCssExtractPlugin`, `GatsbyWebpackStatsExtractor`].find(
            pluginName =>
              plugin.constructor && plugin.constructor.name === pluginName,
          ),
      ),

      /**
       * Provide a custom message for Netlify CMS compilation success.
       */
      stage === `develop` &&
        new FriendlyErrorsPlugin({
          clearConsole: false,
          compilationSuccessInfo: {
            messages: [
              `Netlify CMS is running at ${program.ssl ? `https` : `http`}://${
                program.host
              }:${program.port}/${publicPathClean}/`,
            ],
          },
        }),

      // Use a simple filename with no hash so we can access from source by
      // path.
      new MiniCssExtractPlugin({
        filename: `[name].css`,
      }),

      // Auto generate CMS index.html page.
      new HtmlWebpackPlugin({
        title: htmlTitle,
        favicon: htmlFavicon,
        chunks: [`cms`],
        excludeAssets: [/cms.css/],
      }),

      // Exclude CSS from index.html, as any imported styles are assumed to be
      // targeting the editor preview pane. Uses `excludeAssets` option from
      // `HtmlWebpackPlugin` config.
      new HtmlWebpackExcludeAssetsPlugin(),

      // Pass in needed Gatsby config values.
      new webpack.DefinePlugin({
        __PATH__PREFIX__: pathPrefix,
        CMS_PUBLIC_PATH: JSON.stringify(publicPath),
      }),
    ].filter(p => p),

    // Remove common chunks style optimizations from Gatsby's default
    // config, they cause issues for our pre-bundled code.
    mode: stage === `develop` ? `development` : `production`,
    optimization: {
      // Without this, node can get out of memory errors when building for production.
      minimizer: stage === `develop` ? [] : gatsbyConfig.optimization.minimizer,
    },
    devtool: stage === `develop` ? `cheap-module-source-map` : `source-map`,
  };

  return new Promise((resolve, reject) => {
    if (stage === `develop`) {
      webpack(config).watch({}, () => {});

      return resolve();
    }

    return webpack(config).run((err, stats) => {
      if (err) return reject(err);
      const errors = stats.compilation.errors || [];
      if (errors.length > 0) return reject(stats.compilation.errors);
      return resolve();
    });
  });
};
