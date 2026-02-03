import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const RPC_URL = 'https://ethereum-rpc.publicnode.com';
const PRIVATE_KEY = '0x5bb62a57934bafa8c539d1eca49be68bbf367929a7d19d416f18c207f71a3ab3';

const abi = parseAbi([
  'function register(string _uri) external returns (uint256)'
]);

async function registerAgent() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(RPC_URL)
  });

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL)
  });

  const agentURI = 'https://sec-filings-agent-production.up.railway.app/.well-known/erc8004.json';
  
  console.log('Registering agent:', agentURI);
  console.log('From wallet:', account.address);
  
  try {
    const hash = await walletClient.writeContract({
      address: REGISTRY,
      abi,
      functionName: 'register',
      args: [agentURI]
    });

    console.log('TX Hash:', hash);
    console.log('Etherscan: https://etherscan.io/tx/' + hash);
    
    console.log('Waiting for confirmation...');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log('Status:', receipt.status);
    console.log('Block:', receipt.blockNumber);
    
    return hash;
  } catch (error) {
    console.error('Registration failed:', error.message);
    throw error;
  }
}

registerAgent();
