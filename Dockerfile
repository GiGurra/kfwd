# syntax = docker/dockerfile:experimental

FROM ubuntu:18.04

# Install some utils
RUN apt update
RUN apt install -y git
RUN apt install -y curl
RUN apt install -y wget
RUN apt install xz-utils

# Install kubectl
RUN curl -LO https://storage.googleapis.com/kubernetes-release/release/`curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt`/bin/linux/amd64/kubectl
RUN chmod +x ./kubectl
RUN cp ./kubectl /usr/local/bin/kubectl

# Install kubens and kubectx
RUN git clone https://github.com/ahmetb/kubectx
RUN cp ./kubectx/kubectx /usr/local/bin/kubectx
RUN cp ./kubectx/kubens /usr/local/bin/kubens

# Install nodejs
RUN wget https://nodejs.org/dist/v10.16.3/node-v10.16.3-linux-x64.tar.xz
RUN tar -xvf ./node-v10.16.3-linux-x64.tar.xz
RUN ln -s /node-v10.16.3-linux-x64/bin/node /usr/local/bin/node
RUN ln -s /node-v10.16.3-linux-x64/bin/npm /usr/local/bin/npm
RUN ln -s /node-v10.16.3-linux-x64/bin/npx /usr/local/bin/npx

COPY lib /lib
COPY index.js /index.js
COPY package.json /package.json
COPY package-lock.json /package-lock.json

RUN npm link

RUN ln -s /node-v10.16.3-linux-x64/bin/kfwd /usr/local/bin/kfwd

ENTRYPOINT ["kfwd"]
