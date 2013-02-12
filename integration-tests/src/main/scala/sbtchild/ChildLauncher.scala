package sbtchild

import com.typesafe.sbtchild._
import java.io.File
import akka.actor._
import akka.pattern._
import akka.dispatch._
import concurrent.duration._
import concurrent.Await
import akka.util.Timeout
import snap.tests._

class CanLaunchThroughSbtLauncher extends IntegrationTest {
  val system = ActorSystem("ManualTest")
  try {
    // TODO - Create project here, rather than rely on it created by test harness....
    val dir = new File("dummy")
    makeDummySbtProject(dir)
    val child = SbtChild(system, dir, new SbtChildLauncher(configuration))
    try {
      implicit val timeout = Timeout(60.seconds)
      val name = Await.result(child ? protocol.NameRequest(sendEvents = false), 60.seconds) match {
        case protocol.NameResponse(n) => {
          n
        }
        case protocol.ErrorResponse(error) =>
          throw new Exception("Failed to get project name: " + error)
      }
      println("Project is: " + name)
      val compiled = Await.result(child ? protocol.CompileRequest(sendEvents = false), 60.seconds) match {
        case protocol.CompileResponse(success) => {
          success
        }
        case protocol.ErrorResponse(error) =>
          throw new Exception("Failed to compile: " + error)
      }
      println("compiled=" + compiled)
      val run = Await.result(child ? protocol.RunRequest(sendEvents = false), 60.seconds) match {
        case protocol.RunResponse(success) => {
          success
        }
        case protocol.ErrorResponse(error) =>
          throw new Exception("Failed to run: " + error)
      }
      println("run=" + run)
    } finally {
      system.stop(child)
    }
  } finally {
    system.shutdown()
  }
}
