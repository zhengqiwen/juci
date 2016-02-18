/*	
	This file is part of JUCI (https://github.com/mkschreder/juci.git)

	Copyright (c) 2015 Martin K. Schröder <mkschreder.uk@gmail.com>

	This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
*/ 

(function(scope){
	var RPC_DEFAULT_SESSION_ID = "00000000000000000000000000000000"; 
	var gettext = function(text){ return text; }; 

	function RevoRPC(){
		this.requests = {}; 
		this.events = {}; 
		this.seq = 1; 
		this.sid = RPC_DEFAULT_SESSION_ID; 
		this.conn_promise = null; 
	}

	RevoRPC.prototype.$sid = function(){
		return localStorage.getItem("sid")||RPC_DEFAULT_SESSION_ID; 
	}
	// Connects to the rpc server. Resolves if connection has been established and fails otherwise. 
	RevoRPC.prototype.$connect = function(address){
		if(this.conn_promise) return this.conn_promise; 
		var self = this; 
		var def = this.conn_promise = $.Deferred(); 
		if(!address) address = this.url; // at first undefined 
		if(!address) address = "ws://"+window.location.host+"/websocket/"; 
		var socket = this.socket = new WebSocket(address); 	
		console.log("connecting to rpc server at ("+address+")"); 
		socket.onopen = function(){
			console.log("RPC connection established!"); 
			self.connected = true; 
			self.url = address;
			def.resolve(); 
		} 
		socket.onerror = function(){
			self.conn_promise = null; 
			self.connected = false; 
			console.log("connection failed!"); 
			def.reject(); 
			setTimeout(function(){
				self.$connect(address); 
			}, 5000); 
		}
		socket.onclose = function(){
			self.conn_promise = null; 
			self.connected = false; 
			setTimeout(function(){
				self.$connect(address); 
			}, 5000); 
		}
		socket.onmessage = function(e){
			// resolve requests 
			var data = e.data; 
			var obj = null; 
			try { obj = JSON.parse(data); } catch(e) { 
				console.error("RPC: could not parse message: "+e+": "+data); 
				return; 
			} 
			if(!(obj instanceof Array) || !obj.map) return; 
			obj.map(function(msg){ 
				if(!msg.jsonrpc || msg.jsonrpc != "2.0") return; 
				// a result message with a matching request
				if(msg.id && msg.result != undefined && self.requests[msg.id]){
					var req = self.requests[msg.id]; 
					console.log("RPC response "+req.method+" "+JSON.stringify(req.params)+" ("+((new Date()).getTime() - req.time)+"ms): "+JSON.stringify(msg.result)); 
					req.deferred.resolve(msg.result); 
				} 
				// an error message for corresponding request
				else if(msg.id && msg.error != undefined && self.requests[msg.id]){
					self.requests[msg.id].deferred.reject(msg.error); 
				} 
				// an event message without id but with method and params
				else if(!msg.id && msg.method && msg.params && self.events[msg.method]){
					self.events[msg.method].map(function(f){
						f({
							type: msg.method, 
							data: msg.params
						}); 
					}); 
				}
			}); 

		} 
		return def.promise(); 
	}

    RevoRPC.prototype.$login = function(username, password){
        var self = this;                
        var def = $.Deferred();         
        self.$request("challenge").done(function(resp){
            console.log("GOT CHALLENGE: "+JSON.stringify(resp)); 
            var sha = new jsSHA("SHA-1", "TEXT");    
            var pwhash = new jsSHA("SHA-1", "TEXT"); 
            pwhash.update(username);    
            sha.update(resp.token);     
            sha.update(pwhash.getHash("HEX"));       
            self.$request("login", [username, sha.getHash("HEX")]).done(function(resp){
                console.log("LOGIN RESULT: "+JSON.stringify(resp)); 
                if(resp.success) scope.localStorage.setItem("sid", resp.success); 
                def.resolve(resp.success);               
            }).fail(function(){         
                def.reject();           
            }); 
        }).fail(function(){             
            def.reject();               
        }); 
        return def.promise();           
    }

    RevoRPC.prototype.$request = function(method, params){
        var self = this; 
		self.seq++; 
		var req = self.requests[self.seq] = {    
			id: self.seq,
			time: (new Date()).getTime(),
			method: method, 
			params: params, 
			deferred: $.Deferred()      
		}; 
		var str = JSON.stringify({      
			jsonrpc: "2.0",             
			id: req.id,                 
			method: method,             
			params: params || []        
		})+"\n";                        
		console.log("websocket > "+str);         
		try {
			self.socket.send(str); 
		} catch(e){
			console.error("Websocket error: "+e); 
			self.socket.onclose(); 
		}
        return req.deferred.promise();  
    }

	RevoRPC.prototype.$authenticate = function(){
		var self = this; 
		var sid = scope.localStorage.getItem("sid")||RPC_DEFAULT_SESSION_ID; 
		var def = $.Deferred(); 
		self.$request("authenticate", [sid]).done(function(){
			self.sid = sid; 
			def.resolve(); 
		}).fail(function(){
			def.reject(); 
		}); 
		return def.promise(); 
	}
	
	RevoRPC.prototype.$call = function(object, method, data){
		var sid = localStorage.getItem("sid")||RPC_DEFAULT_SESSION_ID; 
		data._ubus_session_id = sid; 
		return this.$request("call", [sid, object, method, data]); 
	}

	RevoRPC.prototype.$subscribe = function(name, func){
		if(!this.events[name]) this.events[name] = []; 
		this.events[name].push(func); 
	}

	RevoRPC.prototype.$list = function(){
		var sid = localStorage.getItem("sid")||RPC_DEFAULT_SESSION_ID; 
		return this.$request("list", [sid || "", "*"]); 
	}
	
	RevoRPC.prototype.$register = function(object, method){
		// console.log("registering: "+object+", method: "+method); 
		if(!object || !method) return; 
		var self = this; 
		function _find(path, method, obj){
			if(!obj.hasOwnProperty(path[0])){
				obj[path[0]] = {}; 
			}
			if(!path.length) {
				(function(object, method){
					// create the rpc method
					obj[method] = function(data){
						if(!data) data = { }; 
						return self.$call(object, method, data); 
					}
				})(object, method); 
			} else {
				var child = path[0]; 
				path.shift(); 
				_find(path, method, obj[child]); 
			}
		}
		// support new slash paths /foo/bar..
		var npath = object; 
		if(object.startsWith("/")) npath = object.substring(1); 
		_find(npath.split(/[\.\/]/), method, self); 
	}

	RevoRPC.prototype.$isConnected = function(){
		return this.connected; 
	}

	RevoRPC.prototype.$init = function(host){
		var self = this; 
		var deferred = $.Deferred(); 
		// request list of all methods and construct rpc object containing all of the methods in javascript. 
		self.$list().done(function(result){
			Object.keys(result).map(function(obj){
				Object.keys(result[obj]).map(function(method){
					//console.log("Adding method "+method); 
					self.$register(obj, method); 
				}); 
			}); 
			deferred.resolve(); 
		}).fail(function(){
			deferred.reject(); 
		}); 
		return deferred.promise(); 
	}

	scope.UBUS = scope.$rpc = new RevoRPC(); 
})(typeof exports === 'undefined'? this : global); 

