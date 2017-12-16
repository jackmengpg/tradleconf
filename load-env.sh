#!/bin/bash

NO_ENV_ERROR="expected .env file with variables \"bucket\", \"aws_profile\" and \"stack_name\""

if [ ! -f ".env" ];
then
  echo "$NO_ENV_ERROR"
  exit 1
fi

if [ -z "${local+x}" ]
then
  local="0"
fi

if [ "$local" == "0" ]
then
  source .env
else
  source .env.local
fi

if [ -z "$bucket" ] || [ -z "$aws_profile" ] || [ -z "$stack_name" ];
then
  echo "$NO_ENV_ERROR"
  exit 1
fi

if [ "$local" == "0" ]
then
  s3="aws s3api --profile $aws_profile"
  lambda="aws lambda --profile $aws_profile"
else
  local_s3_endpoint="http://localhost:4572"
  echo "using local s3 endpoint at $local_s3_endpoint"
  s3="aws s3api --endpoint $local_s3_endpoint"
fi
