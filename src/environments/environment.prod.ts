// The file contents for the current environment will overwrite these during build.
// The build system defaults to the dev environment which uses `environment.ts`, but if you do
// `ng build --env=prod` then `environment.prod.ts` will be used instead.
// The list of which env maps to which file can be found in `.angular-cli.json`.
import {networks} from 'bitcoinjs-lib';

export const environment = {
    production: true,
    testnet: false,
    network: networks.bitcoin,
    electrumServer : '',
    electrumPort : 0,
    electrumProtocol : '1.4',
    proxyAddress : 'https://proxy.wallet.mooo.tech',
    bitcoinfeesAddress: 'https://bitcoinfees.earn.com/api/v1/fees/list',
    btc: 'BTC',
    satoshi: 'Satoshi'
};
