const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');
const webpack = require('webpack');

module.exports = (config /*, env*/) => {

    // console.log(config);

    // Heavy bundle! There are options though
    config.optimization.minimize = false;

    // Provide a browser polyfill for `process` (required by the OpenAI SDK,
    // which is loaded in a chunk that otherwise throws "process is not defined").
    // Do not define `process.env` wholesale here: it would bake every build
    // machine variable, including OPENAI_API_KEY loaded from .env, into the
    // bundle. create-react-app already defines the safe subset (NODE_ENV,
    // PUBLIC_URL, REACT_APP_*).
    config.plugins.push(
        new webpack.ProvidePlugin({
            process: 'process/browser',
        })
    );

    // Monaco ESM start
    const options = {
        languages: ['css', 'handlebars', 'html', 'javascript', 'typescript',
            'json', 'less', 'scss', 'xml'],
        features: ['accessibilityHelp', 'bracketMatching', 'caretOperations', 'clipboard',
            'codeAction', 'codelens', 'colorDetector', 'comment', 'contextmenu',
            'coreCommands', 'cursorUndo', 'dnd', 'find', 'folding', 'fontZoom',
            'format', 'gotoError', 'gotoLine', 'gotoSymbol', 'hover', '!iPadShowKeyboard',
            'inPlaceReplace', '!inspectTokens', 'linesOperations', 'links', 'multicursor',
            'parameterHints', 'quickCommand', 'quickOutline', 'referenceSearch', 'rename',
            'smartSelect', 'snippets', 'suggest', '!toggleHighContrast', '!toggleTabFocusMode',
            'transpose', 'wordHighlighter', 'wordOperations', 'wordPartOperations']
    };
    config.plugins.unshift(new MonacoWebpackPlugin(options));
    // Monaco ESM end
    return config;
};