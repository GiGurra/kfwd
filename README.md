# kfwd
Poor man's VPN (tcp port forwardning only) into a kubernetes cluster / kubectl port-forward on steroids.

* spins up a haproxy-pod in the current namespace (using `kubectl run ...`)
* spins up a local docker port-forwarder to the haproxy-pod (1-n `kubectl port-forward` per container/service port)
* edits /etc/localhost (write access required, obv..) or ~/.hosts (HOSTALIASES format)

### Usage
```
╰─>$ kfwd --help
kfwd [options] <args...>

forward dns names to cluster services

Options:
  --help                   Show help                                   [boolean]
  --version                Show version number                         [boolean]
  --use-etc-hosts, -y      Will not ask if to edit /etc/hosts or ~/.hosts.
                           /etc/hosts is automatically selected        [boolean]
  --use-homedir-hosts, -n  Will not ask if to edit /etc/hosts or ~/.hosts.
                           ~/.hosts is automatically selected          [boolean]
  --local, -l              Local docker kfwd mode - should not be used by end
                           users of kfwd. Intended for master internally.
                                                                       [boolean]

Examples:
  kfwd svc1 svc2      Starts kfwd in master mode, forwarding http requests made
                      on this computer to to dns names 'svc1' and 'svc2' ->
                      corresponding kubernetes cluster services. After this you
                      can open a new shell and do `curl http://svc1[:some port]`
```

### Additional examples
 
##### shell 1:
`sudo env "PATH=$PATH" kfwd -y <myservice>` 

(env stuff not necessary if root has nodejs and kubectl configured)

##### shell 2:
`curl my-kubernetes-service`
