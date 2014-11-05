/*
 Copyright (C) 2014 Typesafe, Inc <http://typesafe.com>
 */
define([
  'commons/websocket',
  'commons/stream',
  'commons/types',
  './app'
], function(
  websocket,
  Stream,
  types,
  app
) {

  /**
  Tasks lists
  */
  var executionsById = {};
  var executions = ko.observableArray([]);
  var executionsByJobId = {};
  var tasksById = {};

  function findExecutionIdByTaskId(id) {
    return tasksById[id] && tasksById[id].executionId;
  }

  function findExecutionByTaskId(id) {
    return executionsById[id] && executionsById[id].command;
  }

  /**
  Tasks status
  */
  var workingTasks = {
    compile:  ko.observable(false),
    run:      ko.observable(false),
    test:     ko.observable(false)
  }
  var pendingTasks = {
    compile:  ko.observable(false),
    run:      ko.observable(false),
    test:     ko.observable(false)
  }

  /**
  Stream Events
  */
  var SbtEvents = Stream();

  /**
  Observable as an event dispatcher for complete tasks
  */
  var taskCompleteEvent = ko.observable({});
  taskCompleteEvent.extend({ notify: 'always' });
  function taskComplete(command, succeded){
    taskCompleteEvent({
      command:  command,
      succeded: succeded
    });
  }

  /**
  Task Event results (compile errors and tests)
  */
  var testResults = ko.observableArray([]);
  var compilationErrors = ko.observableArray([]);

  /**
  Temp holder for deferred possible outcomes.
  Uses the serialId as key to the deferred object.
  */
  var deferredRequests = {};
  var clientSerialId = 1;

  function sbtRequest(what, command, executionId) {
    var id = clientSerialId++
    var request = {
      "request" : "sbt",
      "payload" : {
        "serialId": id,
        "type" : what,
        "command": command,
        "executionId": executionId
      }
    };
    websocket.send(request);
    return id;
  }

  /**
   * Returns the client serial id used for this action.
   */
  function requestExecution(command) {
    return sbtRequest('RequestExecution', command);
  }

  /**
   * Reset inspect data
   */
  function resetInspect() {
    debug && console.log("Reset Inspect datas")
    websocket.send({
      "commands": [{
        "module": "lifecycle",
        "command": "reset"
      }]
    });
  }

  /**
  Run command
  */
  var runCommand = ko.computed(function() {
    if (app.currentMainClass()){
      return (app.inspectActivated()?"echo:":"")+"backgroundRunMain "+ app.currentMainClass();
    }
    else {
      return (app.inspectActivated()?"echo:":"")+"backgroundRun";
    }
  });

  /**
   * Returns the result of the execution directly (deferred).
   * Use only when the caller must get the result back in "this" call.
   * Default should be to use "requestExection" as this has better overall performance.
   */
  function requestDeferredExecution(command) {
    var serialId = requestExecution(command);
    var result = $.Deferred();
    deferredRequests[serialId] = result;
    return result;
  }

  /**
   * Returns the client serial id used for this action.
   */
  function cancelExecution(id) {
    return sbtRequest('CancelExecution', "", id);
  }

  /**
   * Returns the result of the cancel execution directly (deferred).
   * Use only when the caller must get the result back in "this" call.
   * Default should be to use "cancelExecution" as this has better overall performance.
   */
  function cancelDeferredExecution(id) {
    var serialId = cancelExecution(id);
    var result = $.Deferred();
    deferredRequests[serialId] = result;
    return result;
  }

  /**
   * Uses a deferred object to "wait" for the result to come back from the server.
   * In other words the caller of this method can expect a result back.
   * See method 'subTypeEventStream("PossibleAutoCompletions")' below for more information about the result layout.
   */
  function deferredPossibleAutoCompletions(partialCommand) {
    var serialId = sbtRequest('PossibleAutoCompletions', partialCommand);
    var result = $.Deferred();
    deferredRequests[serialId] = result;
    return result;
  }

  var sbtEventStream = websocket.subscribe('type','sbt');
  var subTypeEventStream = function(subType) {
    return sbtEventStream.matchOnAttribute('subType',subType);
  }

  // Tasks
  subTypeEventStream("TaskStarted").each(function(message) {
    var execution = executionsById[message.event.executionId]
    if (execution) {
      var task = new Task(message);
      debug && console.log("Starting task ", task);
      // we want to be in the by-id hash before we notify
      // on the tasks array
      tasksById[task.taskId] = task;
      executionsById[task.executionId].tasks[task.taskId] = task;
    } else {
      debug && console.log("Ignoring task for unknown execution " + message.event.executionId)
    }
  });

  subTypeEventStream("TaskFinished").each(function(message) {
    var task = tasksById[message.event.taskId];
    if (task) {
      // we want succeeded flag up-to-date when finished notifies
      task.finished(true);
      delete tasksById[task.taskId];
    }
  });

  subTypeEventStream("TaskEvent").each(function(message) {
    var event = message.event;
    var execution = executionsById[tasksById[event.taskId].executionId];
    if (!execution) throw "Orphan task detected";

    if (event.name === "CompilationFailure") {
      debug && console.log("CompilationFailure: ", event);
      execution.compilationErrors.push(event.serialized);
    } else if (event.name === "TestEvent") {
      debug && console.log("TestEvent: ", event);
      execution.testResults.push(event.serialized);
    }
  });

  subTypeEventStream("BackgroundJobEvent").each(function(message) {
    var execution = executionsById[message.event.serialized.executionId];
    var jobId = message.event.jobId;
    if (message.event.name == "BackgroundJobStarted"){
      debug && console.log("BackgroundJobStarted: ", message);
      executionsByJobId[jobId] = execution;
      execution.jobIds.push(jobId);
    } else if (message.event.name == "BackgroundJobFinished") {
      debug && console.log("BackgroundJobFinished: ", message);
      postExecutionProcess(execution, true);
      delete executionsByJobId[jobId];
    }
  });

  subTypeEventStream("ExecutionWaiting").each(function(message) {

    // If the execution is to stop execution...
    if (stopJob(message)) return;

    var execution = new Execution(message);
    debug && console.log("Waiting execution ", execution);
    // we want to be in the by-id hash before we notify
    // on the executions array
    executionsById[execution.executionId] = execution;
    executions.push(execution);

    // Increment active tasks (to make icons glowing)
    switch(execution.commandId){
      case "compile":
        // Reset the compilation errors
        pendingTasks.compile(pendingTasks.compile()+1);
        break;
      case "run":
        pendingTasks.run(pendingTasks.run()+1);
        break;
      case "test":
        pendingTasks.test(pendingTasks.test()+1);
        break;
    }
  });

  subTypeEventStream("ExecutionStarting").each(function(message) {
    var execution = executionsById[message.event.id];
    if (execution) {
      execution.started(new Date());
      // Increment active tasks (to make icons glowing)
      switch(execution.commandId){
        case "compile":
          // Reset the compilation errors
          workingTasks.compile(workingTasks.compile()+1);
          break;
        case "run":
          workingTasks.run(workingTasks.run()+1);
          break;
        case "test":
          workingTasks.test(workingTasks.test()+1);
          break;
      }
    }
  });

  subTypeEventStream("ExecutionFailure").each(handleSuccessOrFailure);
  subTypeEventStream("ExecutionSuccess").each(handleSuccessOrFailure);
  function handleSuccessOrFailure(message){
    var id = message.event.id;
    var succeeded = message.subType == "ExecutionSuccess";
    var execution = executionsById[id];

    if (execution && !execution.jobIds().length) {
      postExecutionProcess(execution, succeeded);
    }
  }

  function postExecutionProcess(execution, succeeded) {

    // we want succeeded flag up-to-date when finished notifies
    execution.succeeded(succeeded);
    taskComplete(execution.commandId, succeeded); // Throw an event
    execution.finished(new Date());

    // Decrement active tasks (to stop icons glowing if no pending task ;; if counter is 0)
    switch(execution.commandId){
      case "compile":
        workingTasks.compile(workingTasks.compile()-1);
        pendingTasks.compile(pendingTasks.compile()-1);
        break;
      case "run":
        workingTasks.run(workingTasks.run()-1);
        pendingTasks.run(pendingTasks.run()-1);
        break;
      case "test":
        workingTasks.test(workingTasks.test()-1);
        pendingTasks.test(pendingTasks.test()-1);
        break;
    }

    compilationErrors(execution.compilationErrors);
    if (execution.testResults.length) {
      testResults(execution.testResults);
    }

    SbtEvents.push(execution);
  }

  subTypeEventStream("BuildStructureChanged").each(function(message) {
    var projects = message.event.structure.projects;
    if (projects !== undefined && projects.length > 0) {
      app.removeExistingProjects();

      $.each(projects, function(i, v) {
        app.projects.push(v.id.name);
      });

      // FIXME : is there any way to get the current project from the build structure?
      // Right now we just say that the first project in the list also is the current one.
      app.currentProject(app.projects()[0]);
    }
  });

  subTypeEventStream("RequestExecution").each(function(message) {
    debug && console.log("Received request execution result", message);

    var req = deferredRequests[message.serialId];
    if (req !== undefined) {
      delete deferredRequests[message.serialId];
      req.resolve({"result": message.result});
    }
  });

  subTypeEventStream("CancelExecution").each(function(message) {
    debug && console.log("Received cancel execution result", message);

    var req = deferredRequests[message.serialId];
    if (req !== undefined) {
      delete deferredRequests[message.serialId];
      req.resolve({"result": message.result});
    }
  });

  subTypeEventStream("PossibleAutoCompletions").each(function(message) {
    debug && console.log("Received possible auto completions", message);

    var pac = deferredRequests[message.serialId]
    if (pac !== undefined) {
      delete deferredRequests[message.serialId];
      pac.resolve(
        $.map(message.result, function(completion) {
        return {
          title: completion.display,
          subtitle: "run sbt task " + completion.display,
          type: "Sbt",
          url: false,
          execute: message.partialCommand + completion.append,
          callback: function () {
            requestExecution(message.partialCommand + completion.append);
            window.location.hash = "#build";
          }
        }
      }));
    }
  });

  var valueChanged = subTypeEventStream("ValueChanged").map(function(message) {
    var valueOrNull = null;
    if (message.event.value.success)
      valueOrNull = message.event.value;
    debug && console.log("ValueChanged for ", message.event.key.key.name, valueOrNull, message.event);
    return {
      key: message.event.key.key.name,
      value: valueOrNull,
      // TODO insert a project object instance from our projects list ?
      //project: message.event.key.scope.project,
      scopedKey: message.event.key
    }
  });

  // discoveredMainClasses
  valueChanged.matchOnAttribute('key', 'discoveredMainClasses').each(function(message) {
    var discovered = message.value && message.value.serialized || [];
    if (discovered) {
      app.mainClasses(discovered); // All main classes
      if (!app.currentMainClass() && discovered[0]){
        app.currentMainClass(discovered[0]); // Selected main class, if empty
      }
    }
  });

  // Inspect-related (sbt-echo) observables.
  //
  // FIXME these need to be tracked separately for each project.
  // FIXME logically these go in run.js, but they can't go there
  // because it loads lazily so would miss ValueChanged events.

  // Note: this is whether inspect WORKS on the project;
  // It may not be enabled by the user.
  var inspectSupported = ko.observable(false);
  var inspectAkkaVersionReport = ko.observable("");
  var inspectPlayVersionReport = ko.observable("");
  var inspectHasPlayVersion = ko.observable(false);
  var whyInspectIsNotSupported = ko.computed(function() {
    if (inspectSupported())
      return "";
    else if (inspectHasPlayVersion())
      return inspectPlayVersionReport();
    else if (inspectAkkaVersionReport() != "")
      return inspectAkkaVersionReport();
    else
      return "The sbt-echo plugin may not be present on this project or may not be enabled.";
  });

  whyInspectIsNotSupported.subscribe(function(why) {
    if (debug) {
      if (inspectSupported())
        console.log("Inspect is supported");
      else
        console.log("Inspect is not supported because ", why);
    }
  });

  valueChanged.matchOnAttribute('key', 'echoTraceSupported').each(function(message) {
    inspectSupported(message.value.value === true);
  });

  valueChanged.matchOnAttribute('key', 'echoAkkaVersionReport').each(function(message) {
    var report = "";
    if (message.value.value)
      report = message.value.value;
    inspectAkkaVersionReport(report);
  });

  valueChanged.matchOnAttribute('key', 'echoPlayVersionReport').each(function(message) {
    var report = "";
    if (message.value.value)
      report = message.value.value;
    inspectPlayVersionReport(report);
  });

  valueChanged.matchOnAttribute('key', 'echoTracePlayVersion').each(function(message) {
    if (message.value.value && message.value.value != '')
      inspectHasPlayVersion(true);
    else
      inspectHasPlayVersion(false);
  });

  // Application ready
  var clientReady = ko.observable(false);
  var applicationReady = ko.computed(function() {
    return app.mainClasses() && app.mainClasses().length && clientReady();
  });
  var applicationNotReady = ko.computed(function() { return !applicationReady(); });
  subTypeEventStream('ClientOpened').each(function (msg) {
    clientReady(true);
  });
  subTypeEventStream('ClientClosed').each(function (msg) {
    app.mainClasses([]);
    clientReady(false);
  });

  // Killing an execution
  function stopJob(message) {
    if (message.event && message.event.command && message.event.command.slice(0, 7) == "jobStop") {
      var id = message.event.command.slice(8);
      if (executionsById[id]) executionsById[id].stopping(true);
      return true;
    } else {
      return false;
    }
  }

  /**
  Execution object constructor
  */
  function Execution(message) {
    var self = this;
    if (message.event.command[0] == "{"){
      // Get rid of {file://path/to/project} in task names
      message.event.command = message.event.command.replace(/\{.*\}/ig, "");
    }

    self.executionId = message.event.id;
    self.command     = message.event.command;
    self.commandId   = message.event.command.split(/[:\ ]/)[0];
    self.started     = ko.observable(0);
    self.finished    = ko.observable(0); // 0 here stands for no Date() object, yet
    self.finished.extend({ notify: 'always' });
    self.succeeded   = ko.observable();
    self.stopping    = ko.observable(false);
    self.jobIds      = ko.observableArray([]);
    self.logs        = ko.observableArray([]);

    if (self.commandId == "runMain" || self.commandId == "echo" || self.commandId == "backgroundRunMain" || self.commandId == "backgroundRun") self.commandId = "run";

    // Data produced:
    self.tasks          = {};
    self.compilationErrors  = [];
    self.testResults    = [];

    // Statuses
    self.running = ko.computed(function() {
      return !self.finished();
    });
    self.error = ko.computed(function() {
      return self.finished() && !self.succeeded();
    });
    self.time = ko.computed(function() {
      if (self.finished() && self.started()){
        var time = Math.round((self.finished() - self.started()) /1000) +" s";
        var status = self.stopping()||self.jobIds().length?"Stopped after":self.succeeded()?"Completed in":"Failed after";
        return status +" "+ time;
      } else if (self.jobIds().length){
        return "Running in backgound";
      } else if (self.stopping()) {
        return "Stopping the task...";
      } else if (self.started()) {
        return "Running for " + Math.round((new Date() - self.started()) /1000) +" s";
      } else {
        return "Pending...";
      }
    });

    // Update counters in UI
    (function timer() {
      if (!self.finished()){
        self.finished(0); // Force the update of the counter
        setTimeout(timer, 100)
      }
    }());
  }

  function Task(message) {
    var self = this;
    self.executionId = message.event.executionId;
    self.taskId = message.event.taskId;
    self.key = message.event.key ? message.event.key.key.name : null;
    self.finished = ko.observable(0); // 0 here stands for no Date() object
    self.succeeded = ko.observable(0); // 0 here stands for no Date() object
  }


  /**
  Kill tasks by command name (or all pending tasks)
  */
  function killTask(task) {
    executions().filter(function(execution) {
      return !execution.finished() && (execution.jobIds().length || (!task || execution.command == task));
    }).forEach(killExecution);
  }
  function killExecution(execution) {
    if (execution.jobIds().length){
      execution.jobIds().forEach(function(id) {
        requestExecution("jobStop "+id);
      });
    } else {
      cancelExecution(execution.executionId);
    }
  }

  /**
  Check if a task is pending
  */
  function pendingTask(task) {
    return !!executions().filter(function(execution) {
      return !task || execution.command == task;
    }).length;
  }

  $("body").on("click","button[data-exec]",function() {
    var command = $(this).attr('data-exec');
    if (command == "run"){
      command = runCommand();
    }
    if (command) {
      requestExecution(command);
    }
  });

  return {
    sbtRequest:              sbtRequest,
    deferredPossibleAutoCompletions: deferredPossibleAutoCompletions,
    requestExecution:        requestExecution,
    requestDeferredExecution: requestDeferredExecution,
    executions:              executions,
    findExecutionByTaskId:   findExecutionByTaskId,
    findExecutionIdByTaskId: findExecutionIdByTaskId,
    workingTasks:            workingTasks,
    pendingTasks:            pendingTasks,
    testResults:             testResults,
    compilationErrors:       compilationErrors,
    taskCompleteEvent:       taskCompleteEvent,
    SbtEvents:               SbtEvents,
    kill:                    killExecution,
    clientReady:             clientReady,
    applicationReady:        applicationReady,
    applicationNotReady:     applicationNotReady,
    active: {
      turnedOn:     "",
      compiling:    "",
      running:      "",
      testing:      ""
    },
    actions: {
      kill:         killTask,
      turnOnOff:    function() {},
      compile:      function() {
        requestExecution("compile");
      },
      run:          function() {
        if (app.settings.automaticResetInspect()){
          resetInspect();
        }
        return requestExecution(runCommand());
      },
      test:         function() {
        requestExecution("test");
      },
      resetInspect: resetInspect
    }
  }

});
