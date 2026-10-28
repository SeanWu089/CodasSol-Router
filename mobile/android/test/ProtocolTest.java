package com.codassol.mobile;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;
public final class ProtocolTest {
    interface Checked { void run() throws Exception; }
    static int cases=0;
    static void rejects(Checked action) throws Exception { cases++;try {action.run();} catch(Exception expected) {return;} throw new AssertionError("Expected rejection"); }
    static void equal(Object a,Object b) { cases++;if(!a.equals(b))throw new AssertionError(a+" != "+b); }
    public static void main(String[] args) throws Exception {
        equal(Protocol.endpoint(" https://router.example.com/mcp "),"https://router.example.com");
        for(String url:List.of("http://router.test","https://user:secret@router.test","https://router.test/other","https://router.test?token=x","https://router.test/#fragment","https://router.test:0")) rejects(()->Protocol.endpoint(url));
        rejects(()->Protocol.checkJob(false,1,1,100,0));
        rejects(()->Protocol.checkJob(true,2,1,100,0));
        rejects(()->Protocol.checkJob(true,1,1,100,100));
        rejects(()->Protocol.checkJob(true,1,1,4_000_000,0));
        Protocol.checkJob(true,1,1,100,1);
        rejects(()->Protocol.checkCreatedAt(99,100,130)); // queued while access was off
        rejects(()->Protocol.checkCreatedAt(100,100,100)); // invalid deadline
        Protocol.checkCreatedAt(101,100,130); // fresh job in current enabled session
        var seen=new Protocol.SeenJobs();equal(seen.accept("job-1"),true);equal(seen.accept("job-1"),false);equal(seen.accept(""),false);
        var events=new ArrayList<String>();
        Protocol.consume(new StringReader(": comment\r\n\r\nevent: job\r\ndata: first\r\ndata: second\r\n\r\nevent: job\ndata: incomplete"),(type,data)->events.add(type+":"+data));
        equal(events,List.of("job:first\nsecond"));
        rejects(()->Protocol.consume(new StringReader("data: "+"x".repeat(1_048_577)),(type,data)->{}));
        String big="data: "+"x".repeat(600000)+"\ndata: "+"x".repeat(600000)+"\n";
        rejects(()->Protocol.consume(new StringReader(big),(type,data)->{}));
        System.out.println("Protocol boundary checks passed: "+cases);
    }
}
