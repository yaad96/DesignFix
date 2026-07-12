const proxy = require('http-proxy-middleware');

module.exports = function(app) {
  app.use(
    '/openai-proxy',
    proxy({
      target: 'https://api.openai.com',
      changeOrigin: true,
      pathRewrite: {
        '^/openai-proxy': '',
      },
    })
  );
};
