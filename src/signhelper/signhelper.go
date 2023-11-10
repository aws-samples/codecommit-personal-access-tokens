package signhelper

import (
	"fmt"
	"time"
	"strings"
	"encoding/hex"
	"crypto/sha256"
	"crypto/hmac"
	"encoding/base64"
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
)

const (
	authorizationHeader     = "Authorization"
	authHeaderSignatureElem = "Signature="
	signatureQueryKey       = "X-Amz-Signature"

	authHeaderPrefix = "AWS4-HMAC-SHA256"
	timeFormat       = "20060102T150405"
	shortTimeFormat  = "20060102"
	awsV4Request     = "aws4_request"

	// emptyStringSHA256 is a SHA256 of an empty string
	emptyStringSHA256 = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
)

type SignHelper struct {
	region						string
	path							string
	hostname					string
	signTime					time.Time
	secretKey					string
	username					string
}

type CredsValue struct {
	AccessKeyID 			string
	SecretAccessKey 	string
	SessionToken 			string
}

func NewSignHelper (cfg *aws.Config, signTime time.Time, region string, repository string ) *SignHelper {
	creds,err := cfg.Credentials.Retrieve(context.TODO())
	if err != nil {
		panic(err)
	}

	domain := "amazonaws.com"
	version := "v1"
	hostname := fmt.Sprintf("git-codecommit.%s.%s", region, domain)
	path := fmt.Sprintf("/%s/repos/%s",version,repository)
	token := ""
	if creds.SessionToken != "" {
		token = fmt.Sprintf("%%%s",creds.SessionToken)
	}
	username := creds.AccessKeyID + token

	sh := &SignHelper{ 
		region,
		path,
		hostname,
		signTime,
		creds.SecretAccessKey,
		username,
	}
	return sh
}

func (sh SignHelper) GetSignature () string {
	canonical_request := fmt.Sprintf("GIT\n%s\n\nhost:%s\n\nhost\n",sh.path, sh.hostname)
	string_to_sign := strings.Join([]string{
		authHeaderPrefix,
		sh.signTime.Format(timeFormat),
		buildSigningScope(sh.region,"codecommit", sh.signTime),
		hex.EncodeToString(hashSHA256([]byte(canonical_request))),
	}, "\n")
	signatureString := buildSignature(sh.region, "codecommit", sh.secretKey, sh.signTime, string_to_sign)
	signature := fmt.Sprintf("%sZ%s",sh.signTime.Format(timeFormat),signatureString)
	return base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%s:%s",sh.username,signature)))
}

func hashSHA256(data []byte) []byte {
	hash := sha256.New()
	hash.Write(data)
	return hash.Sum(nil)
}

func hmacSHA256(key []byte, data []byte) []byte {
	hash := hmac.New(sha256.New, key)
	hash.Write(data)
	return hash.Sum(nil)
}

func formatShortTime(dt time.Time) string {
	return dt.UTC().Format(shortTimeFormat)
}

func buildSigningScope(region, service string, dt time.Time) string {
	return strings.Join([]string{
		formatShortTime(dt),
		region,
		service,
		awsV4Request,
	}, "/")
}

func deriveSigningKey(region, service, secretKey string, dt time.Time) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secretKey), []byte(formatShortTime(dt)))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	signingKey := hmacSHA256(kService, []byte(awsV4Request))
	return signingKey
}

func buildSignature(region string, service string, secretKey string, dt time.Time, stringToSign string) string {
	creds := deriveSigningKey(region, service, secretKey, dt)
	signature := hmacSHA256(creds, []byte(stringToSign))
	return hex.EncodeToString(signature)
}

