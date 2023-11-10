package main

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"log"
	"time"
	"regexp"
	"flag"
	"context"
	"reflect"
	"unsafe"
	"strings"
	"encoding/base64"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/kms"

	"awsprototype/patproxy/signhelper"
)

func printContextInternals(ctx interface{}, inner bool) {
	contextValues := reflect.ValueOf(ctx).Elem()
	contextKeys := reflect.TypeOf(ctx).Elem()

	if !inner {
			log.Printf("\nFields for %s.%s\n", contextKeys.PkgPath(), contextKeys.Name())
	}

	if contextKeys.Kind() == reflect.Struct {
			for i := 0; i < contextValues.NumField(); i++ {
					reflectValue := contextValues.Field(i)
					reflectValue = reflect.NewAt(reflectValue.Type(), unsafe.Pointer(reflectValue.UnsafeAddr())).Elem()

					reflectField := contextKeys.Field(i)

					if reflectField.Name == "Context" {
							printContextInternals(reflectValue.Interface(), true)
					} else {
							log.Printf("field name: %+v\n", reflectField.Name)
							log.Printf("value: %+v\n", reflectValue.Interface())
					}
			}
	} else {
			log.Printf("context is empty (int)\n")
	}
}

// Struct to unmarshall response from DynamoDB. Must match DynamoDB structure.
type PersonalAccessToken struct {
	Token 		   string      `dynamodbav:"token"`           
	RepoID  	   string			 `dynamodbav:"repoID"`
	Username	   string      `dynamodbav:"username"`
	Expiration   int64       `dynamodbav:"expiration"`  
}

// Simple struct to hold DynamoDB client and tablename.
type TableBasics struct {
	DynamoDbClient *dynamodb.Client
	TableName      string
}

// modifyRequest will override the request and ensure proper PAT.
func modifyRequest(cfg *aws.Config, req *http.Request, ddbTable TableBasics, kmsClient *kms.Client) {
	// Get Authorization header
	authHeader := req.Header.Get("Authorization")
	errorMsg := ""
	if authHeader == "" {
		log.Println("No Auth Header.")
	} else {
		// Get PAT auth string
		authString,err := base64.StdEncoding.DecodeString(strings.TrimPrefix(authHeader, "Basic "))
		if err != nil {
			errorMsg = "Could not decode Auth Header."
		} else {
			// Get RepoID from URL
			repoRE := `\/git\/([a-zA-Z0-9]+)\/?`
			re := regexp.MustCompile(repoRE)
			matches := re.FindStringSubmatch(req.URL.Path)
			if len(matches) > 0 {
				parsedRepoName := matches[1]
				if parsedRepoName != "" {
					// Find all PATs for RepoID
					log.Printf("Finding PATs for %s on table %s.\n",parsedRepoName,ddbTable.TableName)

					var err error
					var response *dynamodb.QueryOutput
					var validPATs []PersonalAccessToken

					NameEx := expression.Name("repoID").Equal(expression.Value(parsedRepoName))
					expr, err := expression.NewBuilder().WithCondition(NameEx).Build()
					if err != nil {
						errorMsg = fmt.Sprintf("Couldn't build expression for query. Here's why: %v\n", err)
					} else {
						response, err = ddbTable.DynamoDbClient.Query(context.TODO(), &dynamodb.QueryInput{
							TableName:                 aws.String(ddbTable.TableName),
							IndexName:								 aws.String("repoIDIndex"),
							ExpressionAttributeNames:  expr.Names(),
							ExpressionAttributeValues: expr.Values(),
							KeyConditionExpression:    expr.Condition(),
						})
						
						if err != nil {
							errorMsg = fmt.Sprintf("Couldn't query for PATs with repoID: %v. Here's why: %v\n", parsedRepoName, err)
						} else {
							err = attributevalue.UnmarshalListOfMaps(response.Items, &validPATs)
							if err != nil {
								errorMsg = fmt.Sprintf("Couldn't unmarshal query response. Here's why: %v\n", err)
							}
						}
					}

					validPAT := false
					now := time.Now()
					// Check passed in PAT with list of valid PATs in DynamoDB.
					for _,s := range validPATs {
						blob, err := base64.StdEncoding.DecodeString(s.Token)
						if err != nil {
							panic("error converting string to blob, " + err.Error())
						}

						input := &kms.DecryptInput{
							CiphertextBlob: blob,
						}

						result, err := kmsClient.Decrypt(context.TODO(), input)
						if err != nil {
							fmt.Println("Got error decrypting data: ", err)
							return
						}
						
						decodedKey := base64.StdEncoding.EncodeToString(result.Plaintext)
						// PAT is valid if it matches username/token and is not expired
						if string(authString) == fmt.Sprintf("%s:%s",s.Username, decodedKey) && s.Expiration > now.Unix() {
							log.Println("Valid PAT found.")
							validPAT = true
						}
					}
					if validPAT {
						t := time.Now().UTC()
						// Get Signature required to auth with codecommit.
						sh := signhelper.NewSignHelper(cfg, t, "us-east-1", matches[1])
						signature := sh.GetSignature()
						// Fix proxy URL
						req.URL.Path = strings.ReplaceAll(req.URL.Path,"/v1/repos/git/","/v1/repos/")
						// Ensure proper Host
						req.Host = "git-codecommit.us-east-1.amazonaws.com"
						// Delete old Auth header
						req.Header.Del("Authorization")
						// Add new Auth header which can auth with CodeCommit.
						req.Header.Add("Authorization","Basic " + signature) 
						log.Println(req)
					} else {
						if errorMsg == "" {
							errorMsg = "Invalid PAT."
						}
					}
				} else {
					errorMsg = "Invalid repository name."
				}
			} else {
				errorMsg = "Invalid repository name."
			}
			if errorMsg != "" {
				log.Printf(errorMsg)
				ctx, cancel := context.WithCancel(req.Context())
				ctx = context.WithValue(ctx, "errorMsg", errorMsg)
				*req = *req.WithContext(ctx)
				cancel()
				return
			}
		}
	}
}

// Error handler func. Will write out error message to the response.
func errorHandler() func(http.ResponseWriter, *http.Request, error) {
	return func(w http.ResponseWriter, req *http.Request, err error) {
		ctx := req.Context()
		errorMsg := ctx.Value("errorMsg")
		w.WriteHeader(http.StatusInternalServerError)
    w.Write([]byte(errorMsg.(string)))
		return
	}
}

// NewProxy takes target host and creates a reverse proxy
func NewProxy(cfg *aws.Config, targetHost string, ddbTable TableBasics, kmsClient *kms.Client) (*httputil.ReverseProxy, error) {
	url, err := url.Parse(targetHost)
	if err != nil {
		return nil, err
	}

	proxy := httputil.NewSingleHostReverseProxy(url)

	// Director will override the request with PAT checking func: modifyRequest
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		modifyRequest(cfg,req,ddbTable,kmsClient)
	}

	// Response can be overriden here. Currently only prints out to log if the response is not 200.
	proxy.ModifyResponse = func(res *http.Response) error {
		if res.StatusCode != 200 {
			log.Println(res)
		}
		return nil
	}
	
	// Error handling func.
	proxy.ErrorHandler = errorHandler()
	return proxy, nil
}

// ProxyRequestHandler handles the http request using proxy.
func ProxyRequestHandler(proxy *httputil.ReverseProxy) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(w, r)
	}
}

// Entry point for Reverse Proxy
func ReverseHttpsProxy(port int,dst string,crt string,key string,ddbTable TableBasics,kmsClient *kms.Client,cfg *aws.Config) {
	// initialize a reverse proxy and pass the actual backend server url here
	proxy, e := NewProxy(cfg,dst,ddbTable,kmsClient)
	if e != nil {
		panic(e)
	}

	// handle all requests to your server using the proxy. /git/ is where most requests will go. /health/ is for the ELB health checks.
	http.HandleFunc("/git/", ProxyRequestHandler(proxy))
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "{\"status\":0}")
	})

	// Serve TLS for http reverse proxy
	err := http.ListenAndServeTLS(fmt.Sprintf(":%d",port), crt,key,nil)
	if err != nil {
		log.Println("Error:",err)
	}       
}

func main() {
	var TableName string
	var SSLCert string
	var SSLKey string
	var GitURL string

	// Name of the DynamoDB table for Personal Access Tokens
	flag.StringVar(&TableName, "tablename", "", "PAT DDB Table")

	// SSL Cert for serving SSL server
	flag.StringVar(&SSLCert, "sslcert", "", "SSL Cert")

	// SSL Key for the serving SSL key
	flag.StringVar(&SSLKey, "sslkey", "", "SSL Key")

	// URL to Proxy. i.e: https://git-codecommit.<REGION>.amazonaws.com/
	flag.StringVar(&GitURL, "giturl", "", "Git URL")

	flag.Parse()
	if TableName == "" {
		log.Fatal("Missing PAT table name.")
	}

	if SSLCert == "" {
		log.Fatal("Missing SSL cert.")
	}

	if SSLKey == "" {
		log.Fatal("Missing SSL key.")
	}

	if GitURL == "" {
		log.Fatal("Missing Git URL.")
	}

	// Create default config for aws sdk. Region is set here.
	cfg, err := config.LoadDefaultConfig(context.TODO(), func(o *config.LoadOptions) error {
		o.Region = "us-east-1"
		return nil
	})
	if err != nil {
		panic(err)
	}

	// Create aws sdk clients for DynamoDB and KMS
	ddbClient := dynamodb.NewFromConfig(cfg)
	kmsClient := kms.NewFromConfig(cfg)

	// Struct with DynamoDB client and Tablename. To be passed in.
	ddbTable := TableBasics{
		DynamoDbClient: ddbClient,
		TableName: TableName,
	}

	log.Println("Server started on localhost:8443.")
	log.Println("tablename:", TableName )
	log.Println("sslcert:", SSLCert )
	log.Println("sslkey:", SSLKey )
	log.Println("giturl:", GitURL )

	// Start Proxy. Port can be set here. Default is 8443.
	ReverseHttpsProxy(8443,GitURL,SSLCert,SSLKey,ddbTable,kmsClient,&cfg)
}