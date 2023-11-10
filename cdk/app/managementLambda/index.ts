import { Context, APIGatewayProxyResultV2, APIGatewayProxyEventV2 } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, QueryCommand, AttributeValue, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { KMSClient, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import {v4 as uuidv4} from 'uuid';

const ddbClient = new DynamoDBClient({});
const kmsClient = new KMSClient({});

function stringToHex(str: string): string {
  return str.split('').map(char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}
  
async function generateDataKey(): Promise<any> {
  const command = new GenerateDataKeyCommand({
    KeyId: process.env.KMSKEYID,
    NumberOfBytes: 20
  });
  const response = await kmsClient.send(command);
  let plainTextKey = response.Plaintext ? response.Plaintext : "";
  let encryptedKey = response.CiphertextBlob ? response.CiphertextBlob : "";
  return {
    plainTextKey: Buffer.from(plainTextKey).toString('base64'),
    encryptedKey: Buffer.from(encryptedKey).toString('base64')
  }
}

async function generateToken(repoid: string, username: string, expiration: number): Promise<string> {
  //const token = stringToHex(uuidv4());
  const keys = await generateDataKey();
  
  const command = new PutItemCommand({
    TableName: process.env.TABLENAME, 
    Item: {
      token: {
        S: keys.encryptedKey,
      },
      repoID: {
        S: repoid,
      },
      username:  {
        S: username,
      },
      expiration: {
        N: expiration.toString()
      }
    }
  });
  const response = await ddbClient.send(command);
  let token = keys.plainTextKey;
  return JSON.stringify({
    token,
  });
}

async function listTokensByRepoID(repoid: string, username: string): Promise<string> {
  let items:any[] = [];
  let ExpressionAttributeValues:any = {
    ":v1": {
      "S": repoid
    }
  };
  let KeyConditionExpression:string = "repoID = :v1";
  
  if(username) {
    ExpressionAttributeValues[':v2'] = {
      "S": username
    };
    KeyConditionExpression += " AND username = :v2";
  }

  let LastEvaluatedKey:Record<string, AttributeValue> = { 
    "-1": {
      "S": "-1"
    },
  };

  while(!LastEvaluatedKey["-2"]) {
    let commandInput:any = {
      TableName: process.env.TABLENAME, 
      IndexName: "repoIDIndex",
      ExpressionAttributeValues,
      KeyConditionExpression,
    };

    if(!LastEvaluatedKey["-1"]) {
      commandInput.ExclusiveStartKey = LastEvaluatedKey;
    }
    const command = new QueryCommand(commandInput);
    const response = await ddbClient.send(command);

    if(!response.Items) {
      response.Items = [];
    }

    for(let item of response.Items) {
      items.push(item);
    }
    LastEvaluatedKey = response.LastEvaluatedKey ? response.LastEvaluatedKey : {"-2": {
      "S":"-2",
    }};
  }

  return JSON.stringify({
    "Items": items
  });
}

async function deleteToken(token: string): Promise<string> {
  const command = new DeleteItemCommand({
    TableName: process.env.TABLENAME,
    "Key": {
      "token": {
        "S": token
      },
    },
  });
  const response = await ddbClient.send(command);

  return JSON.stringify({
    "success": 1
  });
}

export const handler = async (event: APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyResultV2> => {
  console.log(`Event: ${JSON.stringify(event, null, 2)}`);
  console.log(`Context: ${JSON.stringify(context, null, 2)}`);

  let statusCode:number = 200;
  let body:string = "";

  switch(event.rawPath) {
    case '/api/GenerateToken':
      try {
        const bodyObj:any = JSON.parse(event.body ? event.body : "");
        if(!bodyObj.repoid || !bodyObj.username) {
          throw new Error("Invalid input.")
        }
        const expiration:number = Math.floor(+new Date(bodyObj.expiration).getTime() / 1000);
        body = await generateToken(bodyObj.repoid, bodyObj.username, expiration);
      } catch(e) {
        console.log(e);
        statusCode = 500;
        body = JSON.stringify({
          "message": "Invalid input."
        });
      }
      break;
    case '/api/ListTokensByRepoID':
      try {
        const bodyObj:any = JSON.parse(event.body ? event.body : "");
        if(!bodyObj.repoid) {
          throw new Error("Invalid input.")
        }
        body = await listTokensByRepoID(bodyObj.repoid, bodyObj.username ? bodyObj.username : "");
      } catch(e) {
        console.log(e);
        statusCode = 500;
        body = JSON.stringify({
          "message": "Invalid input."
        });
      }
      break;
    case '/api/DeleteToken': 
      try {
        const bodyObj:any = JSON.parse(event.body ? event.body : "");
        if(!bodyObj.token) {
          throw new Error("Invalid input.")
        }
        body = await deleteToken(bodyObj.token);
      } catch(e) {
        console.log(e);
        statusCode = 500;
        body = JSON.stringify({
          "message": "Invalid input."
        });
      }
      break;
    default:
      statusCode = 404;
      body = JSON.stringify({
        "message": "Invalid input."
      });
  }

  return {
      statusCode,
      body,
   };
};