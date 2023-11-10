const fetch = require('node-fetch');
const { Command } = require('commander');
const { createSignedFetcher } = require('aws-sigv4-fetch')

const signedFetch = createSignedFetcher({ service: 'execute-api', region: 'us-east-1' });
const program = new Command();

async function main() {

  program.command('generatetoken')
  .option('--repoid <string>', 'repoid')
  .option('--username <string>', 'username')
  .option('--expiration <string>', 'expiration date.')
  .option('--apiurl <string>','url of api.')
  .action(async (options) => {
    if(!options.repoid || !options.username || !options.expiration || !options.apiurl) {
      console.log("Missing required parameters.");
      process.exit(1);
    }
    options.apiurl = options.apiurl.endsWith('/') ? options.apiurl.slice(0, -1) : options.apiurl;
    const response = await signedFetch(options.apiurl+"/api/GenerateToken", {method: 'POST', body: JSON.stringify({
      "repoid": options.repoid,
      "username": options.username,
      "expiration": options.expiration,
    })});
    const data = await response.json();

    console.log(data);
  });

  program.command('listtokensbyrepoid')
  .option('--repoid <string>', 'repoid')
  .option('--username <string>', 'username')
  .option('--apiurl <string>','url of api.')
  .action(async (options) => {
    if(!options.repoid || !options.apiurl) {
      console.log("Missing required parameters.");
      process.exit(1);
    }
    if(!options.username) {
      options.username = "";
    }
    options.apiurl = options.apiurl.endsWith('/') ? options.apiurl.slice(0, -1) : options.apiurl;
    const response = await signedFetch(options.apiurl+"/api/ListTokensByRepoID", {method: 'POST', body: JSON.stringify({
      "repoid": options.repoid,
      "username": options.username,
    })});
    const data = await response.json();

    console.log(JSON.stringify(data));
  });

  program.command('deletetoken')
  .option('--token <string>', 'repoid')
  .option('--apiurl <string>','url of api.')
  .action(async (options) => {
    if(!options.token) {
      console.log("Missing required parameters.");
      process.exit(1);
    }
    options.apiurl = options.apiurl.endsWith('/') ? options.apiurl.slice(0, -1) : options.apiurl;
    const response = await signedFetch(options.apiurl+"/api/DeleteToken", {method: 'POST', body: JSON.stringify({
      "token": options.token,
    })});
    const data = await response.json();

    console.log(data);
  });

  program.parse(process.argv);
}

main();
