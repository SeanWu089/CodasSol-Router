import com.codassol.mobile.AgentState;
public final class SessionStateTest {
    public static void main(String[] args) {
        AgentState state = AgentState.INSTANCE;
        long old = state.enable();
        state.connect(old);
        state.disable();
        long current = state.enable();
        state.connect(current);
        if (state.disconnect(old) || !state.getConnected()) throw new AssertionError("Old stream changed replacement session");
        if (!state.disconnect(current) || state.getConnected()) throw new AssertionError("Current stream was not disconnected");
        if (state.connect(old) || state.getConnected()) throw new AssertionError("Old ready event changed replacement session");
        state.disable();
        if (state.disconnect(current)) throw new AssertionError("Disabled session accepted callback");
        System.out.println("Session isolation checks passed: 4");
    }
}
