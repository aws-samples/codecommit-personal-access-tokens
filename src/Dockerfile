FROM golang:latest as build

WORKDIR /app

ENV GOPROXY=direct

COPY . /app/
RUN go mod download

RUN CGO_ENABLED=0 GOOS=linux go build -o /app/patproxy 

FROM alpine:latest AS runtime

WORKDIR /app
COPY --from=build /app/patproxy .

EXPOSE 8080

CMD ["sh","-c","/app/patproxy -tablename $PATTABLENAME -sslcert $SSLCERT -sslkey $SSLKEY -giturl $GITURL"]



