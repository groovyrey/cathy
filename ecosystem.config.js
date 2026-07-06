module.exports = {
  apps: [
    {
      name: "discord-bot",
      script: "src/index.ts",
      interpreter: "node_modules/.bin/tsx",
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
